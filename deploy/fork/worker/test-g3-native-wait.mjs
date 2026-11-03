import * as NodeAssert from "node:assert/strict";
import * as NodeHttp from "node:http";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const { NodeWS } = await import(
  NodeURL.pathToFileURL(
    NodePath.resolve("apps/server/node_modules/@effect/platform-node/dist/NodeSocket.js"),
  )
);
let code = "";
for await (const part of process.stdin) code += part;
const server = NodeHttp.createServer();
const sockets = new NodeWS.WebSocketServer({ server });
let acknowledgedIncomplete = false;
sockets.on("connection", (socket) =>
  socket.on("message", (bytes) => {
    const message = JSON.parse(String(bytes));
    if (message._tag === "Request") {
      socket.send(
        JSON.stringify({
          _tag: "Chunk",
          requestId: "1",
          values: [
            {
              kind: "snapshot",
              projection: {
                runtimeRequests: [
                  {
                    id: "not-native",
                    kind: "command",
                    status: "pending",
                    providerTurnId: "turn",
                    nativeRequestRef: null,
                  },
                ],
              },
            },
          ],
        }),
      );
    } else if (message._tag === "Ack") {
      acknowledgedIncomplete = true;
      socket.send(
        JSON.stringify({
          _tag: "Chunk",
          requestId: "1",
          values: [
            {
              kind: "event",
              event: {
                type: "runtime-request.updated",
                payload: {
                  id: "native",
                  kind: "command",
                  status: "pending",
                  providerTurnId: "turn",
                  nativeRequestRef: { driver: "codex", nativeId: "native-command" },
                },
              },
            },
          ],
        }),
      );
    }
  }),
);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const child = NodeChildProcess.spawn(process.execPath, ["-e", code], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let error = "";
  child.stdout.on("data", (bytes) => {
    output += bytes;
  });
  child.stderr.on("data", (bytes) => {
    error += bytes;
  });
  child.stdin.end(
    JSON.stringify({
      url: `ws://127.0.0.1:${server.address().port}`,
      tag: "orchestration.subscribeThread",
      payload: { threadId: "fixture" },
    }),
  );
  const exit = await new Promise((resolve) => child.on("exit", resolve));
  NodeAssert.equal(exit, 0, error);
  NodeAssert.ok(acknowledgedIncomplete);
  NodeAssert.deepEqual(JSON.parse(output), { nativePending: true, requestId: "native" });
} finally {
  for (const socket of sockets.clients) socket.terminate();
  await new Promise((resolve) => sockets.close(resolve));
  await new Promise((resolve) => server.close(resolve));
}
console.log(
  "Native milestone requires a pending command with provider turn and native reference; no model turn",
);
