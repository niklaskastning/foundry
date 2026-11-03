const NodeChildProcess = require("node:child_process");
const NodeReadline = require("node:readline");

async function inspect(input) {
  const child = NodeChildProcess.spawn(input.command, input.args, {
    detached: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const exited = new Promise((resolve) => child.once("close", resolve));
  const pending = new Map();
  let sequence = 0;
  const fail = () => {
    for (const waiter of pending.values()) waiter.reject(new Error("Native history unavailable"));
    pending.clear();
  };
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.on("exit", fail);
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
    fail();
  }, 40000);
  const lines = NodeReadline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      fail();
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error("Native history rejected"));
    else waiter.resolve(message.result);
  });
  const request = (method, params) => {
    const waiter = Promise.withResolvers();
    const id = ++sequence;
    pending.set(id, waiter);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return waiter.promise;
  };
  try {
    await request("initialize", {
      clientInfo: { name: "foundry-g3-read-only-history", version: "1" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }) + "\n");
    const ids = new Set([input.threadId]);
    const report = {
      nativeStopConfirmed: true,
      threadsChecked: 0,
      nativeTurnFound: false,
      nativeTurnStatus: null,
      inProgressTurns: 0,
      inProgressCommands: 0,
      fullHistory: true,
    };
    for (const id of ids) {
      if (ids.size > 256) throw new Error("Native child limit exceeded");
      const { thread } = await request("thread/read", { threadId: id, includeTurns: true });
      report.threadsChecked++;
      if (!["idle", "notLoaded"].includes(thread.status.type)) report.nativeStopConfirmed = false;
      for (const turn of thread.turns) {
        if (id === input.threadId && turn.id === input.turnId) {
          report.nativeTurnFound = true;
          report.nativeTurnStatus = turn.status;
        }
        if (turn.status === "inProgress") report.inProgressTurns++;
        if (turn.itemsView !== "full") report.fullHistory = false;
        for (const item of turn.items) {
          if (item.type === "commandExecution" && item.status === "inProgress")
            report.inProgressCommands++;
          if (item.type === "collabAgentToolCall")
            for (const childId of item.receiverThreadIds) ids.add(childId);
          if (item.type === "subAgentActivity") ids.add(item.agentThreadId);
        }
      }
    }
    report.nativeStopConfirmed &&=
      report.nativeTurnFound &&
      report.nativeTurnStatus !== "inProgress" &&
      report.inProgressTurns === 0 &&
      report.inProgressCommands === 0 &&
      report.fullHistory;
    return report;
  } finally {
    child.stdin.end();
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
    await exited;
    clearTimeout(timer);
    lines.close();
  }
}

(async () => {
  let data = "";
  for await (const part of process.stdin) data += part;
  try {
    console.log(JSON.stringify(await inspect(JSON.parse(data))));
  } catch {
    console.error("Native history probe failed; no turn resumed or started");
    process.exitCode = 1;
  }
})();
