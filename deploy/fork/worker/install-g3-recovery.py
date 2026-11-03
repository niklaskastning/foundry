#!/usr/bin/env python3
"""Install a pinned worker-only G3 recovery build after a fresh native stop probe."""

from contextlib import closing
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import pwd
import re
import sqlite3
import sys
import tarfile
import tempfile

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("g3", Path(__file__).with_name("bind-codex-g3.py"))
g3 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g3)
worker = g3.worker


def artifacts(stage):
    manifest = json.loads((stage / "release.json").read_text())
    if not re.fullmatch(r"[a-f0-9]{40}", manifest["revision"]):
        raise RuntimeError("Invalid pinned revision")
    archive = stage / "worker-release.tar.gz"
    with archive.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    if digest != manifest["sha256"]:
        raise RuntimeError("Release archive changed")
    with tarfile.open(archive, "r:gz") as source:
        for member in source:
            name = PurePosixPath(member.name)
            if name.is_absolute() or ".." in name.parts or not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                raise RuntimeError("Unsafe archive member")
            if member.issym() or member.islnk():
                target = posixpath.normpath(posixpath.join(posixpath.dirname(member.name) if member.issym() else "", member.linkname))
                if target.startswith("/") or target == ".." or target.startswith("../"):
                    raise RuntimeError("Archive link escapes release")
        metadata = json.load(source.extractfile("./dist/foundry-build.json"))
    if metadata != {"repository": "niklaskastning/foundry", "revision": manifest["revision"], "dirty": False}:
        raise RuntimeError("Expected a clean pinned Foundry build")
    return manifest


def main():
    if len(sys.argv) not in (2, 3) or (len(sys.argv) == 3 and sys.argv[2] != "--check"):
        raise RuntimeError("Use install-g3-recovery.py STAGE [--check]")
    stage = Path(sys.argv[1]).resolve(strict=True)
    manifest = artifacts(stage)
    if sys.argv[2:] == ["--check"]:
        print(json.dumps({"artifactsVerified": True, **manifest, "scope": "dedicated worker only", "paidStarts": 0}))
        return
    if os.geteuid() != 0:
        raise RuntimeError("Administrator required")
    os.umask(0o077)
    installation = worker.Installation("/")
    previous = installation.previous()
    config = dict(previous["config"])
    account = pwd.getpwnam("foundry-worker")
    for unit in ("foundry-host.service", "foundry-connector.service"):
        pid = int(g3.run(["/usr/bin/systemctl", "show", unit, "--property=MainPID", "--value"]))
        process = Path("/proc") / str(pid)
        if pid <= 0 or process.stat().st_uid != account.pw_uid or (process / "cwd").resolve() != Path(worker.WORKER_HOME):
            raise RuntimeError("Unexpected worker service process")
        if (process / "cgroup").read_text().strip() != "0::/foundry.slice/foundry-host.slice/" + unit:
            raise RuntimeError("Unexpected worker cgroup")
    if config.get("providerInstanceId") != g3.BINDING:
        raise RuntimeError("Unexpected worker provider binding")
    record = json.loads(installation.path(json.loads(installation.path(g3.ACTIVE_POINTER).read_text())["record"]).read_text())
    if record.get("phase") != "owned-cgroups-empty":
        raise RuntimeError("Original crash never confirmed empty owned cgroups")
    database = Path(worker.T3 + "/userdata/statev2.sqlite")
    proof = g3.validate_restart_state(database, database.with_name("foundry-workspaces.sqlite"), record)
    if proof["state"] != "uncertain" or proof["writerEnded"] or proof["manifest"] is not None or not proof["reservationHeld"]:
        raise RuntimeError("Expected exactly the fenced original execution")
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as connection:
        unresolved = connection.execute("SELECT count(*) FROM foundry_executions WHERE manifest IS NULL AND command_id != ?", (record["launch"]["commandId"],)).fetchone()[0]
        active = connection.execute("SELECT count(*) FROM orchestration_v2_projection_runs WHERE status NOT IN ('completed','interrupted','cancelled','failed','rolled_back','superseded')").fetchone()[0]
    if unresolved or active:
        raise RuntimeError("Other active or unresolved work; refuse update")
    if not g3.native_restart_summary(config, record)["nativeStopConfirmed"]:
        raise RuntimeError("Native writer stop not confirmed; refuse update")
    config["revision"] = manifest["revision"]
    worker.validate(config)
    release = Path(worker.release(config))
    if release.exists():
        raise RuntimeError("Release destination exists; inspect before retry")
    release.mkdir(parents=True, mode=0o755)
    with tarfile.open(stage / "worker-release.tar.gz", "r:gz") as source:
        source.extractall(release, filter="data")
    for directory, _, files in os.walk(release, followlinks=False):
        Path(directory).chmod(0o755)
        for name in files:
            path = Path(directory) / name
            if not path.is_symlink():
                path.chmod(0o755 if path.stat().st_mode & 0o111 else 0o644)
    version = g3.run([config["node"], str(release / "dist/bin.mjs"), "--version"], account=True)
    recovery = Path(tempfile.mkdtemp(prefix="worker-g3-recovery-", dir="/var/lib/foundry-deploy"))
    (recovery / "previous-installation.json").write_text(json.dumps(previous, indent=2))
    config_file = recovery / "worker.json"
    config_file.write_text(json.dumps(config))
    print("Private configuration recovery: " + str(recovery), flush=True)
    g3.run(["/usr/bin/systemctl", "stop", "foundry-host.target", "foundry-host.slice"])
    installation.stopped()
    for unit in ("foundry-host.service", "foundry-connector.service"):
        group = Path("/sys/fs/cgroup/foundry.slice/foundry-host.slice") / unit / "cgroup.procs"
        if group.exists() and group.read_text().strip():
            raise RuntimeError("Owned worker cgroup still contains processes; keep stopped")
    if installation.previous() != previous:
        raise RuntimeError("Worker configuration changed; keep stopped")
    for source in (database, database.with_name("foundry-workspaces.sqlite")):
        with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as original:
            with closing(sqlite3.connect(recovery / source.name)) as snapshot:
                original.backup(snapshot)
    installation.install(config)
    g3.run(["/usr/bin/systemctl", "daemon-reload"])
    g3.run(["/usr/bin/systemctl", "start", "foundry-host.target"])
    print(json.dumps({"workerUpdateRequested": True, "revision": manifest["revision"], "runtimeVerifiedAsWorker": version,
                      "nativeStopRechecked": True, "paidStarts": 0, "mainChanged": False,
                      "next": "Run bind-codex-g3.py status, then active-recovery-verify; no replacement turn"}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("G3 recovery update stopped: " + type(error).__name__ + ": " + str(error), file=sys.stderr)
        sys.exit(1)
