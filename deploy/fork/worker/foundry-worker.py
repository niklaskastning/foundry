#!/usr/bin/env python3
"""Install only Foundry-owned system units; never provision users or start services."""

import argparse
import fcntl
import json
import os
from pathlib import Path
import pwd
import re
import subprocess
import tempfile
from urllib.parse import urlsplit

STATE = "/var/lib/foundry-worker"
WORKER_HOME = STATE + "/home"
T3 = STATE + "/t3"
WORKSPACES = "/srv/foundry-worker/workspaces"
CONFIG = "/etc/foundry-worker"
UNITS = "/etc/systemd/system"
NAMES = ("foundry-host.target", "foundry-host.slice", "foundry-host.service", "foundry-connector.service")
MANIFEST = CONFIG + "/installation.json"


def validate(config):
    if set(config) - {"providerInstanceId"} != {"revision", "node", "origin", "port", "workspaceRoots", "cpuQuotaPercent", "memoryMaxMiB", "tasksMax", "accessFile"}:
        raise ValueError("Supply exactly the documented worker configuration fields")
    if not isinstance(config["revision"], str) or not re.fullmatch(r"[0-9a-f]{40}", config["revision"]):
        raise ValueError("A full release commit is required")
    if not isinstance(config["node"], str) or not re.fullmatch(r"/(?:usr|opt)/[A-Za-z0-9_./-]+/node", config["node"]) or ".." in Path(config["node"]).parts:
        raise ValueError("Node must be an absolute executable outside user homes")
    origin = urlsplit(config["origin"])
    if origin.scheme != "https" or not origin.hostname or origin.username or origin.password or origin.path or origin.query or origin.fragment or not re.fullmatch(r"https://[A-Za-z0-9.:-]+", config["origin"]):
        raise ValueError("Main must be an HTTPS origin without credentials or a path")
    for name, maximum in (("port", 65535), ("cpuQuotaPercent", 10000), ("memoryMaxMiB", 1048576), ("tasksMax", 1048576)):
        if type(config[name]) is not int or not 1 <= config[name] <= maximum:
            raise ValueError("Invalid numeric resource budget or port")
    if config["port"] < 1024 or type(config["accessFile"]) is not bool:
        raise ValueError("Use an unprivileged port and explicit Access-file selection")
    roots = config["workspaceRoots"]
    if not isinstance(roots, list) or not 1 <= len(roots) <= 32 or any(not isinstance(p, str) or not re.fullmatch(WORKSPACES + r"/[A-Za-z0-9_-]+", p) for p in roots) or len(set(roots)) != len(roots):
        raise ValueError("Workspace roots must be distinct direct children of " + WORKSPACES)
    if "providerInstanceId" in config and (not isinstance(config["providerInstanceId"], str) or not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_-]{0,63}", config["providerInstanceId"])):
        raise ValueError("Invalid provider instance binding")
    return config


def release(config):
    return "/opt/foundry-worker/releases/" + config["revision"]


def render(config):
    validate(config)
    entry = release(config) + "/dist/bin.mjs"
    command = config["node"] + " " + entry
    common = f"""[Service]
Type=simple
User=foundry-worker
Group=foundry-worker
Slice=foundry-host.slice
WorkingDirectory={WORKER_HOME}
Environment=HOME={WORKER_HOME}
Environment=T3CODE_HOME={T3}
Environment=PATH=/opt/foundry-worker/providers/bin:/usr/local/bin:/usr/bin:/bin
Environment=FOUNDRY_WORKER_ENABLED=true
Environment=FOUNDRY_WORKER_PROVIDER_INSTANCE_ID={config.get("providerInstanceId", "")}
Environment=NODE_ENV=production
Environment=T3CODE_TELEMETRY_ENABLED=false
Environment=T3CODE_DISABLE_AUTO_UPDATE=1
UMask=0077
NoNewPrivileges=true
CapabilityBoundingSet=
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
ReadWritePaths={STATE} {' '.join(config['workspaceRoots'])}
Restart=on-failure
RestartSec=5
KillMode=control-group
TimeoutStopSec=90
StandardOutput=journal
StandardError=journal
"""
    connector = f"{command} foundry connect-device --base-dir {T3} --origin {config['origin']} --registration {STATE}/registration.json --key-file {STATE}/device-key.json --gateway-origin http://127.0.0.1:{config['port']} --streams"
    if config["accessFile"]:
        connector += f" --access-file {STATE}/access.json"
    return {
        "foundry-host.target": "[Unit]\nDescription=Foundry host worker\nWants=foundry-host.service foundry-connector.service\nAfter=network-online.target\n\n[Install]\nWantedBy=multi-user.target\n",
        "foundry-host.slice": f"[Unit]\nDescription=Foundry worker resource budget\n\n[Slice]\nCPUQuota={config['cpuQuotaPercent']}%\nMemoryMax={config['memoryMaxMiB']}M\nTasksMax={config['tasksMax']}\n",
        "foundry-host.service": "[Unit]\nDescription=Foundry isolated T3 host\nPartOf=foundry-host.target\nAfter=network-online.target\nWants=network-online.target foundry-connector.service\n\n" + common + f"ExecStart={command} --base-dir {T3} --host 127.0.0.1 --port {config['port']} --no-browser\n",
        "foundry-connector.service": f"[Unit]\nDescription=Foundry outgoing device connector\nPartOf=foundry-host.target foundry-host.service\nAfter=foundry-host.service network-online.target\nRequires=foundry-host.service\nConditionPathExists={STATE}/registration.json\nConditionPathExists={STATE}/device-key.json\n\n" + common + f"ExecStart={connector}\n",
    }


class Installation:
    def __init__(self, root):
        self.root = Path(root).absolute()
        if self.root.is_symlink() or self.root.resolve() != self.root:
            raise ValueError("Root must not contain symlinks")
        self.live = self.root == Path("/")
        if self.live and os.geteuid() != 0:
            raise PermissionError("Live installation requires an administrator; no sudo is invoked")

    def path(self, name):
        path = self.root / name.lstrip("/")
        for part in [path, *path.parents]:
            if part == self.root:
                break
            if part.is_symlink():
                raise ValueError("Refusing a symlink in a managed path")
        return path

    def stopped(self):
        if not self.live:
            return
        for unit in NAMES:
            result = subprocess.run(["systemctl", "show", unit, "--property=ActiveState", "--value"], check=True, capture_output=True, text=True)
            if result.stdout.strip() not in ("inactive", "failed"):
                raise RuntimeError("Stop the complete Foundry target and slice before changing installation")

    def previous(self):
        manifest = self.path(MANIFEST)
        if not manifest.exists():
            if any(self.path(UNITS + "/" + name).exists() for name in NAMES):
                raise RuntimeError("Unowned Foundry unit already exists")
            return None
        record = json.loads(manifest.read_text())
        if set(record) != {"version", "config", "units"} or record["version"] != 1 or set(record["units"]) != set(NAMES):
            raise ValueError("Unsupported installation manifest")
        validate(record["config"])
        for name, expected in record["units"].items():
            if self.path(UNITS + "/" + name).read_text() != expected:
                raise RuntimeError("Managed units changed outside this installer; reconcile them explicitly")
        return record

    def write(self, name, text, mode):
        destination = self.path(name)
        destination.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=".foundry-", dir=destination.parent)
        try:
            with os.fdopen(fd, "w") as stream:
                stream.write(text)
                stream.flush()
                os.fsync(stream.fileno())
                os.fchmod(stream.fileno(), mode)
            os.replace(temporary, destination)
        finally:
            Path(temporary).unlink(missing_ok=True)

    def install(self, config):
        validate(config)
        self.stopped()
        previous = self.previous()
        if previous and any(previous["config"][field] != config[field] for field in ("port", "origin", "workspaceRoots")):
            raise ValueError("Upgrade must preserve origin, port and workspace roots; instance migration is separate")
        metadata = json.loads(self.path(release(config) + "/dist/foundry-build.json").read_text())
        if metadata != {"repository": "niklaskastning/foundry", "revision": config["revision"], "dirty": False}:
            raise ValueError("Release needs matching clean Foundry build metadata")
        if not self.path(release(config) + "/dist/bin.mjs").is_file():
            raise ValueError("Release entrypoint is missing")
        account = None
        if self.live:
            account = pwd.getpwnam("foundry-worker")
            if account.pw_uid == 0 or account.pw_gid == 0 or account.pw_dir != WORKER_HOME or account.pw_shell not in ("/usr/sbin/nologin", "/sbin/nologin", "/bin/false"):
                raise ValueError("A dedicated non-login foundry-worker account with the documented home is required")
            if not os.access(self.path(config["node"]), os.X_OK):
                raise ValueError("Configured Node executable is not executable")
            for name in (config["node"], release(config), release(config) + "/dist", release(config) + "/dist/bin.mjs", release(config) + "/dist/foundry-build.json"):
                info = self.path(name).stat()
                if info.st_uid != 0 or info.st_mode & 0o022:
                    raise ValueError("Runtime and release entrypoints must be root-owned and not group/world writable")
        for name in (STATE, WORKER_HOME, T3, *config["workspaceRoots"]):
            path = self.path(name)
            if not path.exists():
                path.mkdir(parents=True, mode=0o700)
                if account:
                    os.chown(path, account.pw_uid, account.pw_gid)
            elif path.stat().st_mode & 0o077 or (account and path.stat().st_uid != account.pw_uid):
                raise ValueError("Worker data roots must be private and owned by the dedicated account")
        try:
            for name, contents in render(config).items():
                self.write(UNITS + "/" + name, contents, 0o644)
            self.write(MANIFEST, json.dumps({"version": 1, "config": config, "units": render(config)}, sort_keys=True) + "\n", 0o600)
        except OSError:
            if previous:
                for name, contents in previous["units"].items():
                    self.write(UNITS + "/" + name, contents, 0o644)
            else:
                for name in NAMES:
                    self.path(UNITS + "/" + name).unlink(missing_ok=True)
            raise

    def remove(self):
        self.stopped()
        if self.previous() is None:
            return
        if self.path(UNITS + "/multi-user.target.wants/foundry-host.target").exists():
            raise RuntimeError("Disable foundry-host.target before removal")
        for name in NAMES:
            self.path(UNITS + "/" + name).unlink()
        self.path(MANIFEST).unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("install", "remove"))
    parser.add_argument("--root", default="/", help="Offline filesystem root; never contacts systemd unless root is /")
    parser.add_argument("--config", type=Path)
    args = parser.parse_args()
    installation = Installation(args.root)
    lock = installation.path(CONFIG + "/installer.lock")
    lock.parent.mkdir(parents=True, exist_ok=True)
    with lock.open("a") as stream:
        os.fchmod(stream.fileno(), 0o600)
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.operation == "install":
            if not args.config:
                parser.error("install requires --config")
            installation.install(json.loads(args.config.read_text()))
        else:
            installation.remove()
    print("Foundry unit files updated. Data, keys and releases retained. No service was started.")


if __name__ == "__main__":
    main()
