#!/usr/bin/env python3
"""Bind the dedicated headless Codex installation; never starts an agent turn."""

from contextlib import closing
import importlib.util
import json
import uuid
import os
from pathlib import Path
import pwd
import sqlite3
import subprocess
import sys
import tempfile
import urllib.request

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("foundry_worker", Path(__file__).with_name("foundry-worker.py"))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
BINDING = "codexG3"
CLI = worker.WORKER_HOME + "/tools/codex-cli/node_modules/@openai/codex/bin/codex.js"
SHIM = "/opt/foundry-worker/providers/bin/codex-g3"
RPC = r'''
let input = "";
for await (const part of process.stdin) input += part;
const request = JSON.parse(input);
const socket = new WebSocket(request.url);
const deadline = setTimeout(() => { socket.close(); process.exit(1); }, 40000);
socket.onopen = () => socket.send(JSON.stringify({
  _tag: "Request", id: "1", tag: request.tag, payload: request.payload, headers: []
}));
socket.onerror = () => process.exit(1);
socket.onclose = () => process.exit(1);
socket.onmessage = ({ data }) => {
  const decoded = JSON.parse(data);
  for (const message of Array.isArray(decoded) ? decoded : [decoded]) {
    if (message._tag === "Ping") socket.send(JSON.stringify({ _tag: "Pong" }));
    if (message._tag !== "Exit" || String(message.requestId) !== "1") continue;
    clearTimeout(deadline);
    if (message.exit._tag !== "Success") process.exit(1);
    process.stdout.write(JSON.stringify(message.exit.value ?? null), () => process.exit(0));
  }
};
'''


def run(args, *, account=False, data=None):
    env = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/root"}
    if account:
        args = ["/usr/sbin/runuser", "-u", "foundry-worker", "--", "/usr/bin/env", "-i",
                "HOME=" + worker.WORKER_HOME, "T3CODE_HOME=" + worker.T3,
                "CODEX_HOME=" + worker.WORKER_HOME + "/.codex",
                "PATH=/opt/foundry-worker/providers/bin:/usr/local/bin:/usr/bin:/bin", *args]
    result = subprocess.run(args, cwd=worker.WORKER_HOME, env=env, input=data,
                            text=True, capture_output=True, timeout=60)
    if result.returncode:
        raise RuntimeError("Command failed; private output suppressed: " + args[0])
    return result.stdout.strip()


def quiet_database(database):
    if not database.is_file():
        raise RuntimeError("Worker SQLite missing")
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as connection:
        active = connection.execute("SELECT count(*) FROM orchestration_v2_projection_runs WHERE status NOT IN ('completed','interrupted','cancelled','failed','rolled_back','superseded')").fetchone()[0]
        unfinished = connection.execute("SELECT count(*) FROM foundry_executions WHERE manifest IS NULL").fetchone()[0]
    if active or unfinished:
        raise RuntimeError("Active or unresolved work; refuse binding/restart")
    journal = database.with_name("foundry-workspaces.sqlite")
    if journal.exists():
        with closing(sqlite3.connect(journal.as_uri() + "?mode=ro", uri=True)) as connection:
            if connection.execute("SELECT count(*) FROM reservations WHERE state != 'released'").fetchone()[0]:
                raise RuntimeError("Unreleased writer reservation; refuse binding/restart")


def provider_config():
    return {"driver": "codex", "displayName": "Foundry G3 Codex", "enabled": True,
            "config": {"setupMode": "existing", "binaryPath": SHIM,
                       "homePath": worker.WORKER_HOME + "/.codex",
                       "launchArgs": "-c 'cli_auth_credentials_store=\"file\"'"}}


def rpc(config, tag, payload):
    entry = worker.release(config) + "/dist/bin.mjs"
    session = json.loads(run([config["node"], entry, "auth", "session", "issue",
                             "--base-dir", worker.T3, "--json", "--ttl", "2m",
                             "--scope", "orchestration:read", "--scope", "settings:write",
                             "--scope", "providers:manage"], account=True))
    try:
        origin = f'http://127.0.0.1:{config["port"]}'
        request = urllib.request.Request(origin + "/api/auth/websocket-ticket/rpc", method="POST",
                                         headers={"Authorization": "Bearer " + session["token"]})
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=10) as response:
            ticket = json.load(response)["ticket"]
        from urllib.parse import urlencode
        url = origin.replace("http:", "ws:") + "/ws?" + urlencode({"orchestrationProtocol": 2, "wsTicket": ticket})
        return json.loads(run([config["node"], "-e", RPC], account=True,
                              data=json.dumps({"url": url, "tag": tag, "payload": payload})))
    finally:
        run([config["node"], entry, "auth", "session", "revoke", session["sessionId"],
             "--base-dir", worker.T3], account=True)


def bind():
    if os.geteuid() != 0:
        raise RuntimeError("Administrator required")
    os.umask(0o077)
    installation = worker.Installation("/")
    previous = installation.previous()
    if previous is None:
        raise RuntimeError("No managed worker")
    config = previous["config"]
    if config.get("providerInstanceId") not in (None, "", BINDING):
        raise RuntimeError("Another provider is already bound")
    account = pwd.getpwnam("foundry-worker")
    if account.pw_uid == 0 or account.pw_dir != worker.WORKER_HOME:
        raise RuntimeError("Unexpected worker account")
    if run([config["node"], CLI, "--version"], account=True) != "codex-cli 0.156.1":
        raise RuntimeError("Unexpected Codex version")
    run([config["node"], CLI, "-c", 'cli_auth_credentials_store="file"', "login", "status"], account=True)
    database = Path(worker.T3 + "/userdata/statev2.sqlite")
    quiet_database(database)
    settings_file = database.with_name("settings.json")
    settings_bytes = settings_file.read_bytes()
    settings = json.loads(settings_bytes)
    current = settings.get("providerInstances", {}).get(BINDING)
    if current is not None and current != provider_config():
        raise RuntimeError("Existing provider instance differs")
    shim = installation.path(SHIM)
    content = '#!/bin/sh\nexec ' + config["node"] + ' ' + CLI + ' "$@"\n'
    if shim.exists() and (shim.is_symlink() or shim.read_text() != content or shim.stat().st_uid != 0):
        raise RuntimeError("Existing CLI shim differs")
    recovery = Path(tempfile.mkdtemp(prefix="worker-codex-g3-", dir="/var/lib/foundry-deploy"))
    (recovery / "installation.json").write_text(json.dumps(previous))
    (recovery / "settings.json").write_bytes(settings_bytes)
    print("Private configuration recovery: " + str(recovery), flush=True)
    for directory in (installation.path("/opt/foundry-worker/providers"), shim.parent):
        directory.mkdir(exist_ok=True, mode=0o755)
        if directory.stat().st_uid != 0 or directory.stat().st_mode & 0o022:
            raise RuntimeError("Provider program directory must be root-owned and not writable by others")
        directory.chmod(0o755)
    shim.write_text(content)
    shim.chmod(0o755)
    if run([SHIM, "--version"], account=True) != "codex-cli 0.156.1":
        raise RuntimeError("CLI wrapper is not executable as the worker")
    rpc(config, "server.updateSettings", {"patch": {}, "providerInstanceMutation": {
        "operation": "upsert", "instanceId": BINDING, "instance": provider_config()}})
    quiet_database(database)
    run(["/usr/bin/systemctl", "stop", "foundry-host.target", "foundry-host.slice"])
    try:
        quiet_database(database)
        if installation.previous() != previous:
            raise RuntimeError("Installation changed during binding")
        installation.install({**config, "providerInstanceId": BINDING})
        run(["/usr/bin/systemctl", "daemon-reload"])
        run(["/usr/bin/systemctl", "start", "foundry-host.target"])
    except BaseException:
        run(["/usr/bin/systemctl", "stop", "foundry-host.target", "foundry-host.slice"])
        print("Worker remains stopped; reconcile using private configuration recovery.", file=sys.stderr)
        raise
    workspace = Path(tempfile.mkdtemp(prefix="g3-acceptance-", dir=config["workspaceRoots"][0]))
    os.chown(workspace, account.pw_uid, account.pw_gid)
    run(["/usr/bin/git", "-C", str(workspace), "init", "-q"], account=True)
    run(["/usr/bin/git", "-C", str(workspace), "-c", "user.name=Foundry G3",
         "-c", "user.email=g3@example.invalid", "commit", "--allow-empty", "-qm", "G3 fixture"], account=True)
    (recovery / "fixture-workspace").write_text(str(workspace) + "\n")
    print(json.dumps({"providerBound": BINDING, "paidTurns": 0, "workspace": str(workspace),
                      "next": "Run this helper with status after worker startup"}))


def acceptance_access(workspace_name):
    if os.geteuid() != 0 or os.environ.get("SUDO_USER") != "niklas":
        raise RuntimeError("Run through the maintainer's interactive sudo")
    os.umask(0o077)
    installation = worker.Installation("/")
    config = installation.previous()["config"]
    if config.get("providerInstanceId") != BINDING:
        raise RuntimeError("Expected Codex binding is missing")
    workspace = Path(workspace_name).resolve(strict=True)
    if not workspace.name.startswith("g3-acceptance-") or workspace.parent not in [Path(root) for root in config["workspaceRoots"]]:
        raise RuntimeError("Only a new G3 fixture inside an allowed root is accepted")
    if workspace.stat().st_uid != pwd.getpwnam("foundry-worker").pw_uid:
        raise RuntimeError("Fixture must belong to the worker")
    if run(["/usr/bin/git", "-C", str(workspace), "rev-parse", "--show-toplevel"], account=True) != str(workspace):
        raise RuntimeError("Fixture must be its own repository")
    if run(["/usr/bin/git", "-C", str(workspace), "remote"], account=True) or run(["/usr/bin/git", "-C", str(workspace), "status", "--porcelain"], account=True):
        raise RuntimeError("Fixture must be clean and have no remotes")
    quiet_database(Path(worker.T3 + "/userdata/statev2.sqlite"))
    owner = pwd.getpwnam("niklas")
    directory = Path(owner.pw_dir) / ".cache/foundry-g3-acceptance"
    directory.mkdir(exist_ok=True, mode=0o700)
    if directory.is_symlink() or directory.stat().st_uid != owner.pw_uid:
        raise RuntimeError("Unexpected private acceptance directory")
    directory.chmod(0o700)
    destination = directory / "worker-access.json"
    if destination.exists() or destination.is_symlink():
        raise RuntimeError("Acceptance access already exists; do not overwrite its command ID")
    identifier = "g3-" + str(uuid.uuid4())
    request = {"commandId": identifier, "projectId": identifier + "-project", "title": "G3 minimal Luna acceptance",
               "model": "gpt-6-luna", "prompt": "Create exactly one file G3.txt containing exactly FOUNDRY_G3_OK followed by a newline. Use only this repository. Do not create commits, contact external services, start background processes, spawn subagents or perform any other task. Finish with a brief confirmation."}
    entry = worker.release(config) + "/dist/bin.mjs"
    session = json.loads(run([config["node"], entry, "auth", "session", "issue", "--base-dir", worker.T3,
                             "--json", "--ttl", "30m", "--label", "Foundry bounded G3 acceptance",
                             "--scope", "orchestration:read", "--scope", "orchestration:operate"], account=True))
    try:
        with destination.open("x") as stream:
            json.dump({"origin": f'http://127.0.0.1:{config["port"]}', "workspace": str(workspace),
                       "launch": request, "sessionId": session["sessionId"], "token": session["token"],
                       "expiresAt": session["expiresAt"]}, stream)
        os.chown(destination, owner.pw_uid, owner.pw_gid)
        destination.chmod(0o600)
    except BaseException:
        run([config["node"], entry, "auth", "session", "revoke", session["sessionId"], "--base-dir", worker.T3], account=True)
        raise
    print(json.dumps({"privateAccessFile": str(destination), "expiresAt": session["expiresAt"], "paidTurns": 0,
                      "workspace": str(workspace), "commandId": identifier}))


def persisted_acceptance(database, command_id, receipt, expected_manifest):
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as connection:
        row = connection.execute("SELECT thread_id,generation,writer_ended,manifest FROM foundry_executions WHERE command_id=?", (command_id,)).fetchone()
        if not row or row[2] != 1 or row[3] is None or row[0] != receipt["threadId"]:
            raise RuntimeError("No persisted writer-end/manifest proof")
        thread_id, generation, _, encoded = row
        manifest = json.loads(encoded)
        if manifest != expected_manifest or manifest["generation"] != generation:
            raise RuntimeError("Manifest or generation differs")
        for table, identity in (("threads", "thread_id"), ("runs", "thread_id"), ("run_attempts", "thread_id"), ("provider_turns", "thread_id")):
            count = connection.execute(f"SELECT count(*) FROM orchestration_v2_projection_{table} WHERE {identity}=?", (thread_id,)).fetchone()[0]
            if count != 1:
                raise RuntimeError("Expected exactly one thread/run/attempt")
        checkpoint = connection.execute("SELECT thread_id,run_id,status FROM orchestration_v2_projection_checkpoints WHERE checkpoint_id=?", (manifest["checkpointId"],)).fetchone()
        if checkpoint != (thread_id, manifest["runId"], "ready"):
            raise RuntimeError("Checkpoint ownership or ready state differs")
    return manifest


def verify_acceptance(access_name="worker-access.json"):
    if os.geteuid() != 0:
        raise RuntimeError("Administrator required")
    owner = pwd.getpwnam("niklas")
    if access_name not in ("worker-access.json", "second-access.json"):
        raise RuntimeError("Only the two prepared acceptance cases may be verified")
    access_file = Path(owner.pw_dir) / ".cache/foundry-g3-acceptance" / access_name
    access = json.loads(access_file.read_text())
    result_file = Path(str(access_file) + ".result.json")
    report = json.loads(result_file.read_text())
    config = worker.Installation("/").previous()["config"]
    database = Path(worker.T3 + "/userdata/statev2.sqlite")
    if report.get("failure") or report.get("commandId") != access["launch"]["commandId"]:
        raise RuntimeError("Runner did not confirm its original execution")
    manifest = persisted_acceptance(database, report["commandId"], report["receipt"], report["execution"]["lifecycle"]["manifest"])
    workspace = Path(access["workspace"]).resolve(strict=True)
    if workspace.parent not in [Path(root) for root in config["workspaceRoots"]] or not workspace.name.startswith("g3-acceptance-"):
        raise RuntimeError("Unexpected fixture workspace")
    run(["/usr/bin/git", "-C", str(workspace), "cat-file", "-e", manifest["checkpointRef"] + "^{commit}"], account=True)
    if run(["/usr/bin/git", "-C", str(workspace), "show", manifest["checkpointRef"] + ":G3.txt"], account=True) != "FOUNDRY_G3_OK":
        raise RuntimeError("Checkpoint file differs")
    if (workspace / "G3.txt").is_symlink() or (workspace / "G3.txt").read_bytes() != b"FOUNDRY_G3_OK\n":
        raise RuntimeError("Workspace file differs")
    run([config["node"], worker.release(config) + "/dist/bin.mjs", "auth", "session", "revoke", access["sessionId"], "--base-dir", worker.T3], account=True)
    proof = {"commandId": report["commandId"], "exactlyOneThreadRunAttempt": True,
             "writerEnded": True, "manifest": manifest, "checkpointReadyAndGitObjectPresent": True,
             "fileContentsVerified": True, "acceptanceSessionRevoked": True,
             "g3FullyAccepted": False}
    proof_file = access_file.with_name(access_name + ".verified-proof.json")
    with proof_file.open("x") as stream:
        json.dump(proof, stream, indent=2)
    proof_file.chmod(0o600)
    os.chown(proof_file, owner.pw_uid, owner.pw_gid)
    print(json.dumps(proof, indent=2))


def restart_idle():
    if os.geteuid() != 0:
        raise RuntimeError("Administrator required")
    config = worker.Installation("/").previous()["config"]
    if config.get("providerInstanceId") != BINDING:
        raise RuntimeError("Expected worker binding is missing")
    database = Path(worker.T3 + "/userdata/statev2.sqlite")
    quiet_database(database)
    old_pid = int(run(["/usr/bin/systemctl", "show", "foundry-host.service", "--property=MainPID", "--value"]))
    if old_pid <= 0:
        raise RuntimeError("Worker is not running")
    os.umask(0o077)
    recovery = Path(tempfile.mkdtemp(prefix="worker-g3-restart-", dir="/var/lib/foundry-deploy"))
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as connection:
        rows = connection.execute("SELECT command_id,generation,state,writer_ended,manifest FROM foundry_executions ORDER BY generation").fetchall()
    (recovery / "execution-snapshot.json").write_text(json.dumps(rows))
    run(["/usr/bin/systemctl", "stop", "foundry-host.target", "foundry-host.slice"])
    quiet_database(database)
    if run(["/usr/bin/systemctl", "show", "foundry-host.service", "--property=MainPID", "--value"]) != "0":
        raise RuntimeError("Worker did not stop")
    for unit in ("foundry-host.service", "foundry-connector.service"):
        group = Path("/sys/fs/cgroup/foundry.slice/foundry-host.slice") / unit / "cgroup.procs"
        if group.exists() and group.read_text().strip():
            raise RuntimeError("Worker cgroup still contains processes")
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as connection:
        if connection.execute("SELECT command_id,generation,state,writer_ended,manifest FROM foundry_executions ORDER BY generation").fetchall() != rows:
            raise RuntimeError("Executions changed during stop; keep worker stopped")
    run(["/usr/bin/systemctl", "start", "foundry-host.target"])
    print(json.dumps({"restartRequested": True, "oldWorkerPid": old_pid, "oldWorkerCgroupsEmpty": True,
                      "executionSnapshot": str(recovery / "execution-snapshot.json"), "paidTurns": 0,
                      "next": "After startup run status and verify-acceptance second-access.json"}))


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "acceptance-access":
        acceptance_access(sys.argv[2])
    elif sys.argv[1:] == ["verify-acceptance"]:
        verify_acceptance()
    elif len(sys.argv) == 3 and sys.argv[1] == "verify-acceptance":
        verify_acceptance(sys.argv[2])
    elif sys.argv[1:] == ["restart-idle"]:
        restart_idle()
    elif sys.argv[1:] == ["bind"]:
        bind()
    elif sys.argv[1:] == ["status"]:
        record = worker.Installation("/").previous()
        if record is None:
            raise RuntimeError("No managed worker")
        status = rpc(record["config"], "foundry.workerStatus", {})
        if status["providerReady"]:
            server = rpc(record["config"], "server.getConfig", {})
            provider = next((entry for entry in server["providers"] if entry["instanceId"] == status["providerInstanceId"]), None)
            status["availableModels"] = [model["slug"] for model in provider["models"]] if provider else []
        print(json.dumps(status, indent=2))
    else:
        raise RuntimeError("Use bind, status or acceptance-access WORKSPACE; none starts an agent turn")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("G3 Codex setup failed: " + (str(error) if isinstance(error, RuntimeError) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
