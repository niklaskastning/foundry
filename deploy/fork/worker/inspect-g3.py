#!/usr/bin/env python3
"""Read-only G3 worker inventory; no login, provider turn, restart or acceptance claim."""

import argparse
import importlib.util
import json
from pathlib import Path
import pwd
import subprocess
import sys
import urllib.request

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location("foundry_worker", Path(__file__).with_name("foundry-worker.py"))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/root"}


def command(args, cwd="/"):
    result = subprocess.run(args, cwd=cwd, env=ENV, capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise RuntimeError("Inventory command failed; private output suppressed: " + args[0])
    return result.stdout.strip()


def inventory(root="/"):
    installation = worker.Installation(root)
    record = installation.previous()
    if record is None:
        raise RuntimeError("No managed worker installation")
    config = record["config"]
    release = worker.release(config)
    metadata = json.loads(installation.path(release + "/dist/foundry-build.json").read_text())
    if metadata != {"repository": "niklaskastning/foundry", "revision": config["revision"], "dirty": False}:
        raise RuntimeError("Release metadata differs from installation")
    for name in (config["node"], release, release + "/dist", release + "/dist/bin.mjs"):
        info = installation.path(name).stat()
        if info.st_mode & 0o022 or (installation.live and info.st_uid != 0):
            raise RuntimeError("Runtime/release ownership or permissions differ")
    report = {
        "revision": config["revision"],
        "origin": config["origin"],
        "port": config["port"],
        "workspaceRoots": config["workspaceRoots"],
        "providerInstanceId": config.get("providerInstanceId"),
        "providerReady": None,
        "g3Accepted": False,
        "paidTurns": 0,
        "runtimeVerifiedAsWorker": False,
        "limitsEnforcedUnderLoad": False,
    }
    if not installation.live:
        report["offlineOnly"] = True
        return report
    account = pwd.getpwnam("foundry-worker")
    if account.pw_uid == 0 or account.pw_gid == 0 or account.pw_dir != worker.WORKER_HOME:
        raise RuntimeError("Unexpected worker account")
    for name in (worker.STATE, worker.WORKER_HOME, worker.T3, *config["workspaceRoots"]):
        info = installation.path(name).stat()
        if info.st_uid != account.pw_uid or info.st_mode & 0o077:
            raise RuntimeError("Worker data root ownership or permissions differ")
    services = {}
    for unit in ("foundry-host.service", "foundry-connector.service"):
        fields = dict(line.split("=", 1) for line in command([
            "/usr/bin/systemctl", "show", unit, "--property=ActiveState,SubState,MainPID,User,Group,ControlGroup,WorkingDirectory",
        ]).splitlines())
        if fields["User"] != "foundry-worker" or fields["Group"] != "foundry-worker" or fields["WorkingDirectory"] != worker.WORKER_HOME:
            raise RuntimeError("Unexpected service identity or working directory")
        group = "/foundry.slice/foundry-host.slice/" + unit
        if fields["ActiveState"] != "active" or fields["ControlGroup"] != group or int(fields["MainPID"]) <= 0:
            raise RuntimeError("Worker service is not active in its expected cgroup")
        process = Path("/proc") / fields["MainPID"]
        if (process / "cwd").resolve() != Path(worker.WORKER_HOME) or process.stat().st_uid != account.pw_uid or "0::" + group not in (process / "cgroup").read_text().splitlines():
            raise RuntimeError("Actual process identity/cgroup differs")
        services[unit] = fields
    cgroup = Path("/sys/fs/cgroup/foundry.slice/foundry-host.slice")
    limits = {name: (cgroup / name).read_text().strip() for name in ("cpu.max", "memory.max", "pids.max")}
    quota, period = limits["cpu.max"].split()
    if quota == "max" or int(quota) * 100 != int(period) * config["cpuQuotaPercent"] or int(limits["memory.max"]) != config["memoryMaxMiB"] * 1024 * 1024 or int(limits["pids.max"]) != config["tasksMax"]:
        raise RuntimeError("Active kernel limits differ from configured budget")
    version = command([
        "/usr/sbin/runuser", "-u", "foundry-worker", "--", "/usr/bin/env", "-i",
        "HOME=" + worker.WORKER_HOME, "PATH=/opt/foundry-worker/providers/bin:/usr/local/bin:/usr/bin:/bin",
        "T3CODE_HOME=" + worker.T3, config["node"], release + "/dist/bin.mjs", "--version",
    ], cwd=worker.WORKER_HOME)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(f'http://127.0.0.1:{config["port"]}/.well-known/t3/environment', timeout=5) as response:
        descriptor = json.load(response)
    managed = bool(config.get("providerInstanceId"))
    if descriptor["capabilities"].get("foundryManagedWorkspaces") is not managed:
        raise RuntimeError("Workspace capability differs from configured binding")
    report.update({
        "services": services, "kernelLimits": limits, "runtimeVersion": version,
        "runtimeVerifiedAsWorker": True, "environmentId": descriptor["environmentId"],
        "managedWorkspaces": managed,
        "next": "Probe bound provider with foundry.workerStatus via an authenticated worker session" if managed else "Install/sign in to dedicated Codex using this worker's provider settings; then configure its explicit instance ID",
    })
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default="/", help="Offline fixture root; skips all commands, HTTP and process inspection")
    args = parser.parse_args()
    try:
        print(json.dumps(inventory(args.root), indent=2))
    except Exception as error:
        detail = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        parser.exit(1, "G3 inventory failed: " + detail + "; no services or credentials changed.\n")


if __name__ == "__main__":
    main()
