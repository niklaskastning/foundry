#!/usr/bin/python3 -I
"""Privileged, fixed-target updater; install outside the writable checkout."""

import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

CONFIG = Path("/etc/foundry-deploy")
STATE = Path("/var/lib/foundry-deploy")
CONTAINER = "foundry-main-1"
REGISTRY = "ghcr.io/niklaskastning/foundry"
SOURCE = "https://github.com/niklaskastning/foundry"
ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/root"}


def docker(*args, image=None, output=None):
    result = subprocess.run(
        ["/usr/bin/docker", "--host", "unix:///var/run/docker.sock",
         "--config", str(CONFIG / "docker"), *args],
        env={**ENV, **({"FOUNDRY_IMAGE": image} if image else {})},
        cwd="/", stdin=subprocess.DEVNULL,
        stdout=output if output else subprocess.PIPE,
        stderr=subprocess.PIPE, check=False, timeout=1800,
    )
    if result.returncode:
        raise RuntimeError(f"Docker {args[0]} failed: {result.stderr.decode().strip()}")
    return result.stdout.decode().strip() if output is None else ""


def compose(*args, image):
    return docker("compose", "--project-name", "foundry", "--env-file", "/dev/null",
                  "--file", str(CONFIG / "compose.yml"), *args, image=image)


def inspect():
    return json.loads(docker("container", "inspect", CONTAINER))[0]


def validate_target(container):
    labels = container["Config"].get("Labels") or {}
    mounts = {m["Destination"]: (m["Type"], m.get("Name")) for m in container["Mounts"]}
    if (labels.get("com.docker.compose.project") != "foundry"
            or labels.get("com.docker.compose.service") != "main"
            or mounts != {"/var/lib/foundry": ("volume", "foundry_foundry-state"),
                          "/workspaces": ("volume", "foundry_foundry-workspaces")}):
        raise RuntimeError("Existing container is not the expected Foundry Compose Main.")
    if container["HostConfig"]["PortBindings"] != {
        "3773/tcp": [{"HostIp": "127.0.0.1", "HostPort": "3783"}]
    }:
        raise RuntimeError("Existing Foundry port mapping differs from the installed configuration.")
    if set(container["NetworkSettings"]["Networks"]) != {"foundry_default"}:
        raise RuntimeError("Existing Foundry network differs from the installed configuration.")
    # This updater deliberately owns only the baseline file-store deployment.
    for value in container["Config"].get("Env") or []:
        if value.startswith("FOUNDRY_"):
            raise RuntimeError("Custom Foundry runtime settings require an operator-managed update.")


def metadata(path, optional=False):
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open("http://127.0.0.1:3783" + path, timeout=10) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        if optional and error.code == 404:
            return None
        raise
    except json.JSONDecodeError:
        if optional:
            return None  # Older builds serve the Web fallback for this unknown route.
        raise


def deploy(digest):
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
        raise ValueError("Expected a sha256 image digest, not a tag, URL or command.")
    image = f"{REGISTRY}@{digest}"
    previous = inspect()
    validate_target(previous)
    previous_image = json.loads(docker("image", "inspect", previous["Image"]))[0]
    if set(previous["Config"].get("Env") or []) != set(previous_image["Config"].get("Env") or []):
        raise RuntimeError("Custom runtime environment requires an operator-managed update.")
    if not previous["State"]["Running"]:
        raise RuntimeError("Foundry must be running before an update; recover it first.")
    before = metadata("/.well-known/t3/environment")
    descriptor = metadata("/.well-known/foundry?protocolVersion=1", optional=True)
    docker("pull", image)
    candidate = json.loads(docker("image", "inspect", image))[0]
    labels = candidate["Config"].get("Labels") or {}
    revision = labels.get("org.opencontainers.image.revision", "")
    if (labels.get("org.opencontainers.image.source") != SOURCE
            or not re.fullmatch(r"[a-f0-9]{40}", revision)
            or candidate.get("Os") != "linux" or candidate.get("Architecture") != "amd64"):
        raise RuntimeError("Image must be a revision-labelled Foundry Linux amd64 build.")
    if candidate["Id"] == previous["Image"]:
        print(f"Already running {revision} ({digest}).")
        return
    backup = Path(tempfile.mkdtemp(prefix="update-", dir=STATE))
    manifest = {"previousImage": previous["Image"], "candidateImage": image,
                "revision": revision, "environmentId": before["environmentId"],
                "instanceId": descriptor["instanceId"] if descriptor else None}
    (backup / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Saving stopped Main state to {backup}", flush=True)
    docker("stop", "--time", "60", CONTAINER)
    try:
        with (backup / "state.tar").open("xb") as output:
            docker("cp", f"{CONTAINER}:/var/lib/foundry/.", "-", output=output)
            output.flush()
            os.fsync(output.fileno())
    except BaseException:
        docker("start", CONTAINER)
        raise
    try:
        compose("up", "--detach", "--no-deps", "--no-build", "--pull", "never",
                "--wait", "--wait-timeout", "180", "main", image=image)
        current = inspect()
        validate_target(current)
        if current["Image"] != candidate["Id"]:
            raise RuntimeError("Running image does not match the requested digest.")
        after = metadata("/.well-known/t3/environment")
        after_descriptor = metadata("/.well-known/foundry?protocolVersion=1")
        if after["environmentId"] != before["environmentId"]:
            raise RuntimeError("Main environment identity changed.")
        if descriptor and after_descriptor["instanceId"] != descriptor["instanceId"]:
            raise RuntimeError("Foundry instance identity changed.")
        if metadata("/api/foundry/ready").get("ready") is not True:
            raise RuntimeError("Foundry is not ready.")
    except BaseException:
        # A candidate may have migrated SQLite; never restart an older binary on it blindly.
        docker("stop", "--time", "60", CONTAINER)
        print(f"Update failed. Main is stopped; operator recovery needs {backup}.", file=sys.stderr)
        raise
    (backup / "success").write_text(revision + "\n")
    print(f"Deployed {revision} ({digest}); environment {after['environmentId']}; backup {backup}")


def main(args):
    if args != ["status"] and not (len(args) == 2 and args[0] == "deploy"):
        raise ValueError("Usage: foundry-deploy status | foundry-deploy deploy sha256:<64 hex digits>")
    if os.geteuid() != 0:
        raise RuntimeError("Run the installed helper with sudo.")
    os.umask(0o077)
    with (STATE / "lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args == ["status"]:
            current = inspect()
            validate_target(current)
            print(json.dumps({"image": current["Image"], "state": current["State"]["Status"],
                              "health": current["State"].get("Health", {}).get("Status"),
                              "revision": (current["Config"].get("Labels") or {}).get(
                                  "org.opencontainers.image.revision")}))
        else:
            deploy(args[1])


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (Exception, KeyboardInterrupt) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
