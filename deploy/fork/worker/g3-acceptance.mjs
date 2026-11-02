import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";

const accessPath = process.argv[2];
const mode = process.argv[3] ?? "prepare";
if (!accessPath || !["prepare", "run-one-luna-turn"].includes(mode))
  throw new Error("Use access-file [prepare|run-one-luna-turn]");
const access = JSON.parse(await NodeFSP.readFile(accessPath, "utf8"));
const request = access.launch;
if (request.model !== "gpt-6-luna") throw new Error("Unexpected model");
const clients = [];
let renewal;
let cutoff;
let current;
let cancelResult;
let paidAttempted = false;
const report = {
  commandId: request.commandId,
  workspace: access.workspace,
  model: request.model,
  paidStartsRequested: 0,
};

async function connect() {
  const response = await fetch(`${access.origin}/api/auth/websocket-ticket/rpc`, {
    method: "POST",
    headers: { Authorization: `Bearer ${access.token}` },
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Ticket HTTP ${response.status}`);
  const { ticket } = await response.json();
  const url = new URL("/ws", access.origin.replace("http:", "ws:"));
  url.searchParams.set("orchestrationProtocol", "2");
  url.searchParams.set("wsTicket", ticket);
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error("Socket open failed"));
  });
  let id = 0;
  const pending = new Map();
  const client = {
    close() {
      socket.onclose = null;
      for (const item of pending.values()) clearTimeout(item.timer);
      pending.clear();
      socket.close();
    },
    call(tag, payload, drop = false) {
      const item = Promise.withResolvers();
      const key = String(++id);
      const timer = setTimeout(() => {
        pending.delete(key);
        item.reject(new Error("RPC deadline"));
      }, 40000);
      pending.set(key, { ...item, drop, timer });
      socket.send(JSON.stringify({ _tag: "Request", id: key, tag, payload, headers: [] }));
      return item.promise;
    },
    follow(payload) {
      const first = Promise.withResolvers();
      const terminal = Promise.withResolvers();
      const values = [];
      const key = String(++id);
      pending.set(key, { values, first, terminal, cursor: payload.afterSequence ?? 0 });
      socket.send(
        JSON.stringify({
          _tag: "Request",
          id: key,
          tag: "foundry.workerFollow",
          payload,
          headers: [],
        }),
      );
      return { values, first: first.promise, terminal: terminal.promise };
    },
  };
  socket.onclose = () => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject?.(new Error("Connection lost"));
      item.first?.reject(new Error("Follow connection lost"));
      item.terminal?.reject(new Error("Follow connection lost"));
    }
    pending.clear();
  };
  socket.onerror = () => undefined;
  socket.onmessage = ({ data }) => {
    for (const message of [JSON.parse(data)].flat()) {
      if (message._tag === "Ping") {
        socket.send(JSON.stringify({ _tag: "Pong" }));
        continue;
      }
      const item = pending.get(String(message.requestId));
      if (!item) continue;
      if (message._tag === "Chunk" && item.values) {
        for (const value of message.values) {
          const previous = item.values.at(-1)?.sequence ?? item.cursor;
          if (value.sequence <= previous) {
            item.terminal.reject(new Error("Non-monotone follow"));
            continue;
          }
          item.values.push(value);
          item.first.resolve(value);
          if (value.execution.lifecycle?.manifest) item.terminal.resolve(value.execution);
        }
        socket.send(JSON.stringify({ _tag: "Ack", requestId: message.requestId }));
      }
      if (message._tag === "Exit") {
        pending.delete(String(message.requestId));
        clearTimeout(item.timer);
        if (message.exit._tag !== "Success") {
          const code = message.exit.cause?.find((cause) => cause._tag === "Fail")?.error?.code;
          const error = new Error(code ?? "RPC failed");
          item.reject?.(error);
          item.first?.reject(error);
          item.terminal?.reject(error);
        } else if (item.drop) {
          item.reject(new Error("Injected lost launch reply"));
          socket.close();
        } else item.resolve?.(message.exit.value);
      }
    }
  };
  clients.push(client);
  return client;
}

try {
  current = await connect();
  report.readiness = await current.call("foundry.workerStatus", {});
  if (
    mode !== "prepare" &&
    (!report.readiness.providerReady ||
      report.readiness.providerInstanceId !== "codexG3" ||
      report.readiness.activeRuns !== 0)
  )
    throw new Error("Worker is not ready and idle");
  await current.call("projects.mutate", {
    type: "project.create",
    commandId: `${request.commandId}:project`,
    projectId: request.projectId,
    title: "G3 acceptance",
    workspaceRoot: access.workspace,
    defaultModelSelection: { instanceId: "codexG3", model: request.model },
  });
  report.projectPrepared = true;
  if (mode === "run-one-luna-turn") {
    const fingerprint = NodeCrypto.createHash("sha256")
      .update(JSON.stringify(request))
      .digest("hex");
    const marker = await NodeFSP.open(`${accessPath}.started`, "wx", 0o600);
    await marker.writeFile(JSON.stringify({ fingerprint, request }));
    await marker.close();
    report.paidStartsRequested = 1;
    paidAttempted = true;
    const deadline = Promise.withResolvers();
    deadline.promise.catch(() => undefined);
    cutoff = setTimeout(async () => {
      try {
        cancelResult = await current.call("foundry.workerCancel", {
          commandId: `${request.commandId}:deadline-cancel`,
          launchCommandId: request.commandId,
        });
      } catch {
        cancelResult = { status: "unconfirmed" };
      }
      deadline.reject(new Error("120-second cutoff; writer stop must be checked before reuse"));
    }, 120000);
    try {
      await current.call("foundry.workerLaunch", request, true);
      throw new Error("Fault injection did not drop reply");
    } catch (error) {
      if (error.message !== "Injected lost launch reply") throw error;
    }
    report.replyDiscardedAtRpcBoundary = true;
    current = await connect();
    const receipt = await current.call("foundry.workerLaunch", request);
    report.receipt = receipt;
    const execution = await current.call("foundry.workerRead", { commandId: request.commandId });
    const generation = execution.lifecycle?.generation;
    if (!Number.isInteger(generation)) throw new Error("No persisted generation");
    if (!execution.lifecycle.manifest) {
      await current.call("foundry.workerRenew", { commandId: request.commandId, generation });
      report.leaseRenewed = true;
    } else report.leaseRenewed = false;
    renewal = setInterval(() => {
      current
        .call("foundry.workerRenew", { commandId: request.commandId, generation })
        .catch(() => deadline.reject(new Error("Lease renewal rejected")));
    }, 20000);
    const follow = current.follow({ commandId: request.commandId });
    // Both follow promises are observed even when the deadline wins.
    follow.terminal.catch(() => undefined);
    const first = await Promise.race([follow.first, deadline.promise]);
    const resumed = current.follow({ commandId: request.commandId, afterSequence: first.sequence });
    resumed.first.catch(() => undefined);
    const final = await Promise.race([resumed.terminal, deadline.promise]);
    const manifest = final.lifecycle?.manifest;
    if (
      !final.lifecycle.writerEnded ||
      manifest?.outcome !== "completed" ||
      !manifest.checkpointId ||
      !manifest.checkpointRef ||
      manifest.generation !== generation ||
      manifest.runId !== final.run.id
    )
      throw new Error("No confirmed completed manifest");
    const readAgain = await current.call("foundry.workerRead", { commandId: request.commandId });
    const retryAgain = await current.call("foundry.workerLaunch", request);
    if (
      JSON.stringify(readAgain.lifecycle.manifest) !== JSON.stringify(manifest) ||
      JSON.stringify(retryAgain) !== JSON.stringify(receipt)
    )
      throw new Error("Manifest or receipt changed");
    report.followSequences = follow.values.map((value) => value.sequence);
    report.resumedAfterSequence = first.sequence;
    report.resumedSequences = resumed.values.map((value) => value.sequence);
    if (
      !report.resumedSequences.length ||
      report.resumedSequences.some((sequence) => sequence <= first.sequence)
    )
      throw new Error("Invalid follow resume");
    report.execution = readAgain;
    report.manifestUnchanged = true;
    report.checkpointGitObjectVerified = false;
    report.next =
      "Verify local Git object, exact thread/run/attempt counts and file contents under worker UID";
  }
  await NodeFSP.writeFile(`${accessPath}.result.json`, JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (paidAttempted && !cancelResult) {
    try {
      cancelResult = await current.call("foundry.workerCancel", {
        commandId: `${request.commandId}:failure-cancel`,
        launchCommandId: request.commandId,
      });
    } catch {
      cancelResult = { status: "unconfirmed" };
    }
  }
  report.failure = error.message;
  report.cancel = cancelResult;
  report.next =
    "Do not start a replacement or release the workspace until writer stop is confirmed";
  await NodeFSP.writeFile(`${accessPath}.result.json`, JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  clearInterval(renewal);
  clearTimeout(cutoff);
  for (const client of clients) client.close();
}
