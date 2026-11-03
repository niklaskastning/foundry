#!/usr/bin/env python3
"""Operate the bounded G3 worker checks; active-restart-start starts one Luna turn."""

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

RPC_NATIVE = RPC.replace(
    '    if (message._tag !== "Exit" || String(message.requestId) !== "1") continue;',
    r'''    if (message._tag === "Chunk" && String(message.requestId) === "1") {
      for (const value of message.values) {
        const requests = value.kind === "snapshot" ? value.projection.runtimeRequests :
          value.kind === "event" && value.event.type === "runtime-request.updated" ? [value.event.payload] : [];
        const pending = requests.find(item => item.kind === "command" && item.status === "pending" && item.providerTurnId && item.nativeRequestRef);
        if (pending) {
          clearTimeout(deadline);
          process.stdout.write(JSON.stringify({ nativePending: true, requestId: pending.id }), () => process.exit(0));
          return;
        }
      }
      socket.send(JSON.stringify({ _tag: "Ack", requestId: "1" }));
    }
    if (message._tag !== "Exit" || String(message.requestId) !== "1") continue;''',
)
ACTIVE_POINTER = "/var/lib/foundry-deploy/g3-active-restart.json"



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


def rpc(config, tag, payload, *, operate=False, settings=False, wait_native=False):
    entry = worker.release(config) + "/dist/bin.mjs"
    scopes = ["orchestration:read"]
    if operate:
        scopes.append("orchestration:operate")
    if settings:
        scopes.extend(["settings:write", "providers:manage"])
    flags = [flag for scope in scopes for flag in ("--scope", scope)]
    session = json.loads(run([config["node"], entry, "auth", "session", "issue",
                             "--base-dir", worker.T3, "--json", "--ttl", "2m", *flags], account=True))
    try:
        origin = f'http://127.0.0.1:{config["port"]}'
        request = urllib.request.Request(origin + "/api/auth/websocket-ticket/rpc", method="POST",
                                         headers={"Authorization": "Bearer " + session["token"]})
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=10) as response:
            ticket = json.load(response)["ticket"]
        from urllib.parse import urlencode
        url = origin.replace("http:", "ws:") + "/ws?" + urlencode({"orchestrationProtocol": 2, "wsTicket": ticket})
        return json.loads(run([config["node"], "-e", RPC_NATIVE if wait_native else RPC], account=True,
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
        "operation": "upsert", "instanceId": BINDING, "instance": provider_config()}}, settings=True)
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


def active_restart_start():
    if os.geteuid() != 0:
        raise RuntimeError("Administrator required")
    os.umask(0o077)
    installation = worker.Installation("/")
    config = installation.previous()["config"]
    pointer = installation.path(ACTIVE_POINTER)
    if pointer.exists():
        raise RuntimeError("An active-restart probe already exists; verify it instead of starting another")
    if config.get("providerInstanceId") != BINDING:
        raise RuntimeError("Expected worker binding is missing")
    quiet_database(Path(worker.T3 + "/userdata/statev2.sqlite"))
    status = rpc(config, "foundry.workerStatus", {})
    if not status["providerReady"] or status["activeRuns"] != 0:
        raise RuntimeError("Worker must be ready and idle")
    account = pwd.getpwnam("foundry-worker")
    for unit in ("foundry-host.service", "foundry-connector.service"):
        pid = int(run(["/usr/bin/systemctl", "show", unit, "--property=MainPID", "--value"]))
        process = Path("/proc") / str(pid)
        if pid <= 0 or process.stat().st_uid != account.pw_uid or (process / "cwd").resolve() != Path(worker.WORKER_HOME):
            raise RuntimeError("Unexpected worker service process")
        if (process / "cgroup").read_text().strip() != "0::/foundry.slice/foundry-host.slice/" + unit:
            raise RuntimeError("Unexpected worker cgroup")
    recovery = Path(tempfile.mkdtemp(prefix="worker-g3-active-", dir="/var/lib/foundry-deploy"))
    workspace = Path(tempfile.mkdtemp(prefix="g3-acceptance-restart-", dir=config["workspaceRoots"][0]))
    os.chown(workspace, account.pw_uid, account.pw_gid)
    run(["/usr/bin/git", "-C", str(workspace), "init", "-q"], account=True)
    run(["/usr/bin/git", "-C", str(workspace), "-c", "user.name=Foundry G3", "-c", "user.email=g3@example.invalid", "commit", "--allow-empty", "-qm", "Active restart fixture"], account=True)
    identifier = "g3-restart-" + str(uuid.uuid4())
    launch = {"commandId": identifier, "projectId": identifier + "-project", "title": "G3 active restart fence", "model": "gpt-6-luna",
              "prompt": "Run pwd and git status --short in this repository. Do not modify files, create commits, spawn subagents, start background processes or contact external services. Finish promptly."}
    record = {"launch": launch, "workspace": str(workspace), "phase": "prepared", "paidStartLimit": 1}
    record_file = recovery / "probe.json"
    record_file.write_text(json.dumps(record))
    with pointer.open("x") as stream:
        json.dump({"record": str(record_file)}, stream)
    print("Private active-restart record: " + str(record_file), flush=True)
    rpc(config, "projects.mutate", {"type": "project.create", "commandId": identifier + ":project", "projectId": launch["projectId"], "title": "G3 active restart", "workspaceRoot": str(workspace)}, operate=True)
    try:
        record["receipt"] = rpc(config, "foundry.workerLaunch", launch, operate=True)
        execution = rpc(config, "foundry.workerRead", {"commandId": identifier})
        record["generation"] = execution["lifecycle"]["generation"]
        rpc(config, "foundry.workerRenew", {"commandId": identifier, "generation": record["generation"]}, operate=True)
        pending = rpc(config, "orchestration.subscribeThread", {"threadId": record["receipt"]["threadId"]}, wait_native=True)
        if not pending or pending.get("nativePending") is not True:
            raise RuntimeError("No native command approval milestone")
        execution = rpc(config, "foundry.workerRead", {"commandId": identifier})
        if execution["lifecycle"]["writerEnded"] or execution["lifecycle"]["state"] != "active" or execution["run"]["status"] not in ("running", "waiting"):
            raise RuntimeError("Turn already ended; refuse claiming an active restart")
        record["nativePending"] = pending
        record["phase"] = "native-active-before-crash"
        record_file.write_text(json.dumps(record))
    except BaseException:
        rpc(config, "foundry.workerCancel", {"commandId": identifier + ":prepare-cancel", "launchCommandId": identifier}, operate=True)
        raise
    run(["/usr/bin/systemctl", "kill", "--kill-whom=all", "--signal=SIGKILL", "foundry-host.service", "foundry-connector.service"])
    run(["/usr/bin/systemctl", "stop", "foundry-host.target", "foundry-host.slice"])
    for unit in ("foundry-host.service", "foundry-connector.service"):
        group = Path("/sys/fs/cgroup/foundry.slice/foundry-host.slice") / unit / "cgroup.procs"
        if group.exists() and group.read_text().strip():
            raise RuntimeError("Owned worker cgroup still contains processes; keep stopped")
    record["phase"] = "owned-cgroups-empty"
    record_file.write_text(json.dumps(record))
    run(["/usr/bin/systemctl", "start", "foundry-host.target"])
    print(json.dumps({"activeRestartRequested": True, "nativeTurnWasPending": True, "oldWorkerCgroupsEmpty": True,
                      "commandId": identifier, "workspace": str(workspace), "paidStartsRequested": 1,
                      "next": "After startup run status and active-restart-verify; never start a replacement"}))


def validate_restart_state(database, journal, record):
    thread_id = record["receipt"]["threadId"]
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as connection:
        row = connection.execute("SELECT thread_id,generation,state,writer_ended,manifest FROM foundry_executions WHERE command_id=?", (record["launch"]["commandId"],)).fetchone()
        if not row or row[0] != thread_id or row[1] != record["generation"]:
            raise RuntimeError("Restart changed the original execution binding")
        for table in ("runs", "run_attempts", "provider_turns"):
            if connection.execute(f"SELECT count(*) FROM orchestration_v2_projection_{table} WHERE thread_id=?", (thread_id,)).fetchone()[0] != 1:
                raise RuntimeError("Restart created or lost a run/attempt/native turn")
        run_id = connection.execute("SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id=?", (thread_id,)).fetchone()[0]
    with closing(sqlite3.connect(journal.as_uri() + "?mode=ro", uri=True)) as connection:
        reservations = connection.execute("SELECT r.state FROM reservations r JOIN writer_bindings b ON r.request_id=b.request_id WHERE b.command_id=? AND b.thread_id=? AND b.generation=?", (record["launch"]["commandId"], thread_id, record["generation"])).fetchall()
    if len(reservations) != 1:
        raise RuntimeError("Restart lost the workspace reservation")
    manifest = json.loads(row[4]) if row[4] is not None else None
    if manifest and (row[3] != 1 or manifest["generation"] != row[1] or manifest.get("runId") != run_id or manifest["outcome"] != "stopped"):
        raise RuntimeError("Restart result lacks a stopped-writer proof")
    if not manifest and (row[2] not in ("uncertain", "stopping", "finalizing") or reservations[0][0] == "released"):
        raise RuntimeError("Unconfirmed writer was unfenced or its workspace released")
    return {"generation": row[1], "state": row[2], "writerEnded": bool(row[3]), "manifest": manifest,
            "reservationHeld": reservations[0][0] != "released", "exactlyOneRunAttemptNativeTurn": True}


def active_restart_verify():
    if os.geteuid() != 0:
        raise RuntimeError("Administrator required")
    installation = worker.Installation("/")
    config = installation.previous()["config"]
    record_file = installation.path(json.loads(installation.path(ACTIVE_POINTER).read_text())["record"])
    record = json.loads(record_file.read_text())
    if record.get("phase") != "owned-cgroups-empty":
        raise RuntimeError("Probe never confirmed its crash/stop milestone")
    execution = rpc(config, "foundry.workerRead", {"commandId": record["launch"]["commandId"]})
    replay = rpc(config, "foundry.workerLaunch", record["launch"], operate=True)
    if replay != record["receipt"] or execution["receipt"] != record["receipt"]:
        raise RuntimeError("Identical retry changed its original receipt")
    database = Path(worker.T3 + "/userdata/statev2.sqlite")
    proof = validate_restart_state(database, database.with_name("foundry-workspaces.sqlite"), record)
    proof.update({"commandId": record["launch"]["commandId"], "receiptUnchanged": True, "newProviderStarts": 0, "g3FullyAccepted": False})
    owner = pwd.getpwnam("niklas")
    output = Path(owner.pw_dir) / ".cache/foundry-g3-acceptance/active-restart-proof.json"
    with output.open("x") as stream:
        json.dump(proof, stream, indent=2)
    os.chmod(output, 0o600)
    os.chown(output, owner.pw_uid, owner.pw_gid)
    print(json.dumps(proof, indent=2))


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "acceptance-access":
        acceptance_access(sys.argv[2])
    elif sys.argv[1:] == ["verify-acceptance"]:
        verify_acceptance()
    elif len(sys.argv) == 3 and sys.argv[1] == "verify-acceptance":
        verify_acceptance(sys.argv[2])
    elif sys.argv[1:] == ["active-restart-start"]:
        active_restart_start()
    elif sys.argv[1:] == ["active-restart-verify"]:
        active_restart_verify()
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
        raise RuntimeError("Use bind/status/acceptance-access/verify-acceptance/restart-idle or active-restart-start/active-restart-verify; only active-restart-start starts one Luna turn")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("G3 Codex setup failed: " + (str(error) if isinstance(error, RuntimeError) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
