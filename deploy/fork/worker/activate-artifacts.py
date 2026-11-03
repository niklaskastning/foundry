#!/usr/bin/python3 -I
"""Activate a pinned artifact publisher on the idle dedicated worker, or restore its configuration."""

from contextlib import closing
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import selectors
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("worker_recovery", Path(__file__).with_name("install-g3-recovery.py"))
release_tools = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release_tools)
g3, worker = release_tools.g3, release_tools.worker
spec = importlib.util.spec_from_file_location("worker_inspection", Path(__file__).with_name("inspect-g3.py"))
inspection = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inspection)
BINDING = worker.STATE + "/artifact-binding.json"
DEPLOY = Path("/var/lib/foundry-deploy")
DATABASE = Path(worker.T3 + "/userdata/statev2.sqlite")


def private_json(installation, name):
    path = installation.path(name)
    info = path.stat()
    if not path.is_file() or info.st_mode & 0o077 or info.st_size > 8192:
        raise RuntimeError("Worker configuration must be a bounded private regular file")
    if installation.live and info.st_uid != pwd.getpwnam("foundry-worker").pw_uid:
        raise RuntimeError("Worker configuration has an unexpected owner")
    return json.loads(path.read_text())


def binding(installation, config):
    device = private_json(installation, worker.STATE + "/registration.json")
    key = private_json(installation, worker.STATE + "/device-key.json")
    if not device.get("instanceId") or not device.get("environmentId") or not device.get("publicKey") or device["publicKey"] != key.get("publicKey") or not key.get("privateKey"):
        raise RuntimeError("Device registration and dedicated key differ")
    value = {"origin": config["origin"], "registrationFile": worker.STATE + "/registration.json",
             "keyFile": worker.STATE + "/device-key.json"}
    if config["accessFile"]:
        access = private_json(installation, worker.STATE + "/access.json")
        if access.get("origin") != config["origin"] or not access.get("clientId") or not access.get("clientSecret"):
            raise RuntimeError("Machine access binding differs")
        value["accessFile"] = worker.STATE + "/access.json"
    return value


def write_binding(installation, contents):
    if contents is None:
        installation.path(BINDING).unlink(missing_ok=True)
        return
    installation.write(BINDING, contents, 0o600)
    if installation.live:
        account = pwd.getpwnam("foundry-worker")
        os.chown(installation.path(BINDING), account.pw_uid, account.pw_gid)


def configure(installation, config):
    installation.stopped()
    value = binding(installation, config)
    path = installation.path(BINDING)
    if path.exists() and private_json(installation, BINDING) != value:
        raise RuntimeError("Existing artifact binding differs; refuse replacement")
    before = path.read_text() if path.exists() else None
    try:
        write_binding(installation, json.dumps(value) + "\n")
        installation.install({**config, "artifactPublication": True})
    except BaseException:
        write_binding(installation, before)
        raise


def unpack(installation, stage, manifest, config):
    destination = installation.path(worker.release(config))
    marker = destination / ".artifact-release.json"
    if destination.exists():
        if not marker.is_file() or json.loads(marker.read_text()) != manifest:
            raise RuntimeError("Release already exists without the expected artifact digest")
        return destination
    destination.mkdir(parents=True, mode=0o755)
    with tarfile.open(stage / "worker-release.tar.gz", "r:gz") as archive:
        archive.extractall(destination, filter="data")
    for directory, _, files in os.walk(destination, followlinks=False):
        Path(directory).chmod(0o755)
        for name in files:
            path = Path(directory) / name
            if not path.is_symlink():
                path.chmod(0o755 if path.stat().st_mode & 0o111 else 0o644)
    marker.write_text(json.dumps(manifest))
    marker.chmod(0o600)
    return destination


def schema():
    schemas = {}
    for path in (DATABASE, DATABASE.with_name("foundry-workspaces.sqlite")):
        if path.exists():
            with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as connection:
                schemas[path.name] = connection.execute("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").fetchall()
    return hashlib.sha256(json.dumps(schemas, sort_keys=True).encode()).hexdigest()


def quiescent():
    g3.quiet_database(DATABASE)
    with closing(sqlite3.connect(DATABASE.as_uri() + "?mode=ro", uri=True)) as connection:
        if connection.execute("SELECT count(*) FROM foundry_executions WHERE writer_ended IS NOT 1").fetchone()[0]:
            raise RuntimeError("Writer end is unconfirmed; refuse update")


def verify_processes(config, report):
    entry = (worker.release(config) + "/dist/bin.mjs").encode()
    for fields in report["services"].values():
        if entry not in (Path("/proc") / fields["MainPID"] / "cmdline").read_bytes().split(b"\0"):
            raise RuntimeError("A worker service is running another release")


def stop(installation):
    g3.run(["/usr/bin/systemctl", "stop", "foundry-host.target", "foundry-host.slice"])
    installation.stopped()
    for unit in ("foundry-host.service", "foundry-connector.service"):
        group = Path("/sys/fs/cgroup/foundry.slice/foundry-host.slice") / unit / "cgroup.procs"
        if group.exists() and group.read_text().strip():
            raise RuntimeError("Owned worker cgroup is not empty; keep stopped")
    quiescent()


def start(config):
    journal = subprocess.Popen(["/usr/bin/journalctl", "--follow", "--lines=0", "--since=@" + str(time.time()),
                                "--unit=foundry-host.service", "--output=cat"], stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/root"}, cwd="/")
    try:
        g3.run(["/usr/bin/systemctl", "start", "foundry-host.slice"])
        # Keep the connector offline until the new local host has been verified.
        g3.run(["/usr/bin/systemctl", "start", "--job-mode=ignore-dependencies", "foundry-host.service"])
        deadline = time.monotonic() + 60
        with selectors.DefaultSelector() as events:
            events.register(journal.stdout, selectors.EVENT_READ)
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not events.select(remaining):
                    raise RuntimeError("Worker startup did not report readiness; keep stopped")
                line = journal.stdout.readline()
                if not line:
                    raise RuntimeError("Worker readiness journal ended")
                if f'Listening on http://127.0.0.1:{config["port"]}'.encode() in line:
                    break
        status = g3.rpc(config, "foundry.workerStatus", {})
        if not status["online"] or not status["providerReady"] or status["activeRuns"] != 0:
            raise RuntimeError("Bound worker is not ready and idle; keep stopped")
        g3.run(["/usr/bin/systemctl", "start", "foundry-host.target"])
        verify_processes(config, inspection.inventory())
    finally:
        journal.terminate()
        journal.wait(timeout=5)


def main(args):
    if len(args) != 2 or args[0] not in ("install", "rollback"):
        raise RuntimeError("Use activate-artifacts.py install STAGE | rollback RECOVERY")
    if os.geteuid() != 0:
        raise RuntimeError("Administrator required")
    os.umask(0o077)
    installation = worker.Installation("/")
    with (DEPLOY / "lock").open("a") as lock, installation.path(worker.CONFIG + "/installer.lock").open("a") as installer_lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(installer_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        previous = installation.previous()
        quiescent()
        if args[0] == "rollback":
            recovery = Path(args[1]).resolve(strict=True)
            info = recovery.stat()
            if recovery.parent != DEPLOY or not recovery.name.startswith("worker-artifacts-") or info.st_uid != 0 or info.st_mode & 0o077:
                raise RuntimeError("Expected a private operator recovery directory")
            record = json.loads((recovery / "manifest.json").read_text())
            if schema() != record["schema"]:
                raise RuntimeError("Worker SQLite schema changed; configuration-only rollback is unsafe")
            config = record["previous"]["config"]
            stop(installation)
            installation.install(config)
            write_binding(installation, record["binding"])
        else:
            stage = Path(args[1]).resolve(strict=True)
            manifest = release_tools.artifacts(stage)
            config = {**previous["config"], "revision": manifest["revision"]}
            if not config.get("providerInstanceId"):
                raise RuntimeError("Dedicated provider binding is missing")
            value = binding(installation, config)
            device = private_json(installation, value["registrationFile"])
            report = inspection.inventory()
            verify_processes(previous["config"], report)
            if report["environmentId"] != device["environmentId"]:
                raise RuntimeError("Actual worker environment differs from registration")
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open("http://127.0.0.1:3783/.well-known/foundry?protocolVersion=1", timeout=5) as response:
                descriptor = json.load(response)
            if descriptor["instanceId"] != device["instanceId"] or descriptor.get("instanceAuth", {}).get("publicOrigin") != config["origin"] or descriptor.get("artifactTransfer") != {"protocolVersion": "1", "chunkBytes": 262144, "maxBytes": 52428800}:
                raise RuntimeError("Main identity or enabled artifact profile differs")
            release = unpack(installation, stage, manifest, config)
            g3.run([config["node"], str(release / "dist/bin.mjs"), "--version"], account=True)
            recovery = Path(tempfile.mkdtemp(prefix="worker-artifacts-", dir=DEPLOY))
            old_binding = installation.path(BINDING)
            record = {"previous": previous, "schema": schema(), "binding": old_binding.read_text() if old_binding.exists() else None}
            (recovery / "manifest.json").write_text(json.dumps(record))
            print("Private configuration recovery: " + str(recovery), flush=True)
            stop(installation)
            if installation.previous() != previous:
                raise RuntimeError("Worker installation changed; keep stopped")
            for source in (DATABASE, DATABASE.with_name("foundry-workspaces.sqlite")):
                if source.exists():
                    with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as original:
                        with closing(sqlite3.connect(recovery / source.name)) as snapshot:
                            original.backup(snapshot)
            configure(installation, config)
        g3.run(["/usr/bin/systemctl", "daemon-reload"])
        try:
            start(config)
        except BaseException:
            stop(installation)
            raise
        (recovery / ("success" if args[0] == "install" else "rollback-success")).write_text(config["revision"] + "\n")
        installed = installation.previous()["config"]
        print(json.dumps({"previousRevision": previous["config"]["revision"], "revision": config["revision"],
                          "artifactPublication": installed.get("artifactPublication", False), "servicesReady": True,
                          "recovery": str(recovery), "mainChanged": False, "paidStarts": 0}))


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (Exception, KeyboardInterrupt) as error:
        print("Worker artifact operation stopped: " + (str(error) if isinstance(error, RuntimeError) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
