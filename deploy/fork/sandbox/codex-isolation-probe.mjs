import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";
import * as NodeFS from "node:fs";
NodeFS.mkdirSync("/run/foundry/codex", { recursive: true });
NodeFS.mkdirSync("/workspace/repo", { recursive: true });
NodeChildProcess.execFileSync("git", ["init", "--quiet", "/workspace/repo"]);
NodeChildProcess.execFileSync("git", [
  "-C",
  "/workspace/repo",
  "-c",
  "user.name=Fixture",
  "-c",
  "user.email=fixture@example.invalid",
  "commit",
  "--allow-empty",
  "--quiet",
  "-m",
  "fixture",
]);
NodeChildProcess.execFileSync("git", [
  "-C",
  "/workspace/repo",
  "worktree",
  "add",
  "--detach",
  "--quiet",
  "/workspace/runtime",
]);
NodeChildProcess.execFileSync("git", [
  "-C",
  "/workspace/runtime",
  "sparse-checkout",
  "init",
  "--cone",
]);
NodeFS.writeFileSync("/workspace/runtime/input", "FIXTURE_READ_OK");
NodeFS.writeFileSync("/workspace/outside", "seed");
const child = NodeChildProcess.spawn("codex", ["app-server"], {
  stdio: ["pipe", "pipe", "pipe"],
  cwd: "/workspace/repo",
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
      "if printf forbidden > /workspace/runtime/read-denied 2>/dev/null; then exit 9; fi; cat /workspace/runtime/input",
    ],
    cwd: "/workspace/runtime",
    sandboxPolicy: { type: "readOnly" },
    timeoutMs: 5000,
    outputBytesCap: 4096,
  });
  const write = await call("command/exec", {
    command: [
      "/bin/sh",
      "-c",
      "printf WRITE_OK > /workspace/runtime/allowed; if printf forbidden > /workspace/outside 2>/dev/null; then exit 9; fi; cat /workspace/runtime/allowed",
    ],
    cwd: "/workspace/runtime",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: ["/workspace/runtime"],
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
    cwd: "/workspace/runtime",
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
      readDeniedAbsent: !NodeFS.existsSync("/workspace/runtime/read-denied"),
      writeAllowed:
        NodeFS.existsSync("/workspace/runtime/allowed") &&
        NodeFS.readFileSync("/workspace/runtime/allowed", "utf8") === "WRITE_OK",
    }),
  );
  if (
    read.exitCode !== 0 ||
    write.exitCode !== 0 ||
    escape.exitCode === 0 ||
    NodeFS.existsSync("/workspace/escape") ||
    NodeFS.readFileSync("/workspace/outside", "utf8") !== "seed" ||
    NodeFS.existsSync("/workspace/runtime/read-denied") ||
    !NodeFS.existsSync("/workspace/runtime/allowed") ||
    NodeFS.readFileSync("/workspace/runtime/allowed", "utf8") !== "WRITE_OK"
  )
    process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  child.stdin.end();
  child.kill("SIGTERM");
}
