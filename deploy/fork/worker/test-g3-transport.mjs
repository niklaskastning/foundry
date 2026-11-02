import * as NodeAssert from "node:assert/strict";
import * as NodeHttp from "node:http";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const { NodeWS } = await import(
  NodeURL.pathToFileURL(
    NodePath.resolve("apps/server/node_modules/@effect/platform-node/dist/NodeSocket.js"),
  )
);
for (const invalid of [false, true]) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "g3-transport-"));
  const http = NodeHttp.createServer((request, response) => {
    NodeAssert.equal(request.headers.authorization, "Bearer fixture-private-token");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ticket: "fixture-ticket" }));
  });
  const sockets = new NodeWS.WebSocketServer({ server: http });
  const receipt = {
    commandId: "fixture-launch",
    threadId: "fixture-thread",
    acceptedAt: "2026-11-02T00:00:00Z",
    sequence: 1,
  };
  let launchRequest;
  let deliveries = 0;
  let committed = 0;
  let cancelled = 0;
  let finished = false;
  const state = () => ({
    receipt,
    run: {
      id: "fixture-run",
      status: finished ? "completed" : "running",
      checkpointId: finished ? "checkpoint" : null,
    },
    lifecycle: {
      generation: 1,
      writerEnded: finished,
      manifest: finished
        ? {
            generation: invalid ? 2 : 1,
            runId: "fixture-run",
            checkpointId: "checkpoint",
            checkpointRef: "refs/checkpoints/fixture",
            outcome: "completed",
          }
        : null,
    },
  });
  sockets.on("connection", (socket) =>
    socket.on("message", (bytes) => {
      const message = JSON.parse(String(bytes));
      if (message._tag !== "Request") return;
      const reply = (value) =>
        socket.send(
          JSON.stringify({ _tag: "Exit", requestId: message.id, exit: { _tag: "Success", value } }),
        );
      switch (message.tag) {
        case "foundry.workerStatus":
          return reply({ providerReady: true, providerInstanceId: "codexG3", activeRuns: 0 });
        case "projects.mutate":
          return reply(null);
        case "foundry.workerLaunch":
          deliveries++;
          if (launchRequest) NodeAssert.deepEqual(message.payload, launchRequest);
          else {
            launchRequest = message.payload;
            committed++;
          }
          return reply(receipt);
        case "foundry.workerRead":
          return reply(state());
        case "foundry.workerRenew":
          return reply(null);
        case "foundry.workerCancel":
          cancelled++;
          return reply({ status: "requested" });
        case "foundry.workerFollow": {
          const resumed = message.payload.afterSequence === 2;
          if (resumed) finished = true;
          return socket.send(
            JSON.stringify({
              _tag: "Chunk",
              requestId: message.id,
              values: [{ sequence: resumed ? 3 : 2, execution: state() }],
            }),
          );
        }
        default:
          throw new Error("Unexpected RPC");
      }
    }),
  );
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  try {
    const access = NodePath.join(directory, "access.json");
    await NodeFSP.writeFile(
      access,
      JSON.stringify({
        origin: `http://127.0.0.1:${http.address().port}`,
        token: "fixture-private-token",
        workspace: directory,
        launch: {
          commandId: "fixture-launch",
          projectId: "fixture-project",
          model: "gpt-6-luna",
          title: "fixture",
          prompt: "fixture",
        },
      }),
      { mode: 0o600 },
    );
    const child = NodeChildProcess.spawn(
      process.execPath,
      ["deploy/fork/worker/g3-acceptance.mjs", access, "run-one-luna-turn"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (bytes) => {
      output += bytes;
    });
    child.stderr.on("data", (bytes) => {
      output += bytes;
    });
    const exit = await new Promise((resolve) => child.on("exit", resolve));
    NodeAssert.equal(exit, invalid ? 1 : 0, output);
    NodeAssert.equal(committed, 1);
    NodeAssert.equal(deliveries, invalid ? 2 : 3);
    NodeAssert.equal(cancelled, invalid ? 1 : 0);
    NodeAssert.ok(!output.includes("fixture-private-token") && !output.includes("fixture-ticket"));
    const result = JSON.parse(await NodeFSP.readFile(`${access}.result.json`, "utf8"));
    NodeAssert.equal(result.replyDiscardedAtRpcBoundary, true);
    if (!invalid) {
      NodeAssert.deepEqual(result.resumedSequences, [3]);
      NodeAssert.equal(result.manifestUnchanged, true);
    } else NodeAssert.match(result.failure, /confirmed completed manifest/);
  } finally {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise((resolve) => sockets.close(resolve));
    await new Promise((resolve) => http.close(resolve));
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}
console.log(
  "RPC transport: lost reply, identical retry, follow resume and invalid-generation stop passed; no provider turns",
);
