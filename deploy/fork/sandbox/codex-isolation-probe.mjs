import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";
import * as NodeFS from "node:fs";
NodeFS.mkdirSync("/run/foundry/codex", { recursive: true });
NodeFS.mkdirSync("/workspace/work", { recursive: true });
NodeFS.writeFileSync("/workspace/work/input", "FIXTURE_READ_OK");
NodeFS.writeFileSync("/workspace/outside", "seed");
NodeChildProcess.execFileSync("git", ["init", "--quiet", "/workspace/work"]);
const child = NodeChildProcess.spawn("codex", ["app-server"], {
  stdio: ["pipe", "pipe", "pipe"],
  cwd: "/workspace/work",
  env: { ...process.env, CODEX_HOME: "/run/foundry/codex" },
});
const pending = new Map();
let seq = 0;
child.stderr.on("data", () => {});
NodeReadline.createInterface({ input: child.stdout }).on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.id !== undefined) {
    const p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      if (m.error) p.reject(Error(JSON.stringify(m.error)));
      else p.resolve(m.result);
    }
  }
});
const call = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
const deadline = setTimeout(() => {
  child.kill("SIGKILL");
  process.exitCode = 2;
}, 20000);
try {
  await call("initialize", {
    clientInfo: { name: "foundry-nested-probe", version: "1" },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  const read = await call("command/exec", {
    command: [
      "/bin/sh",
      "-c",
      "if printf forbidden > /workspace/work/read-denied 2>/dev/null; then exit 9; fi; cat /workspace/work/input",
    ],
    cwd: "/workspace/work",
    sandboxPolicy: { type: "readOnly" },
    timeoutMs: 5000,
    outputBytesCap: 4096,
  });
  const write = await call("command/exec", {
    command: [
      "/bin/sh",
      "-c",
      "printf WRITE_OK > /workspace/work/allowed; if printf forbidden > /workspace/outside 2>/dev/null; then exit 9; fi; cat /workspace/work/allowed",
    ],
    cwd: "/workspace/work",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: ["/workspace/work"],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    },
    timeoutMs: 5000,
    outputBytesCap: 4096,
  });
  const escape = await call("command/exec", {
    command: [
      "/bin/sh",
      "-c",
      "unshare --user --map-root-user --mount /bin/sh -c 'mount -o remount,rw /workspace; printf escaped > /workspace/escape'",
    ],
    cwd: "/workspace/work",
    sandboxPolicy: { type: "readOnly" },
    timeoutMs: 5000,
    outputBytesCap: 4096,
  });
  console.log(
    JSON.stringify({
      read,
      write,
      escape,
      escapeAbsent: !NodeFS.existsSync("/workspace/escape"),
      outsideUnchanged: NodeFS.readFileSync("/workspace/outside", "utf8") === "seed",
      readDeniedAbsent: !NodeFS.existsSync("/workspace/work/read-denied"),
      writeAllowed: NodeFS.readFileSync("/workspace/work/allowed", "utf8") === "WRITE_OK",
    }),
  );
  if (
    read.exitCode !== 0 ||
    write.exitCode !== 0 ||
    escape.exitCode === 0 ||
    NodeFS.existsSync("/workspace/escape") ||
    NodeFS.readFileSync("/workspace/outside", "utf8") !== "seed" ||
    NodeFS.existsSync("/workspace/work/read-denied") ||
    NodeFS.readFileSync("/workspace/work/allowed", "utf8") !== "WRITE_OK"
  )
    process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  child.stdin.end();
  child.kill("SIGTERM");
}
