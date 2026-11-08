#!/usr/bin/env python3
"""Stage a dedicated Codex bwrap attachment without changing kernel policy."""
import argparse
import fcntl
import hashlib
import os
from pathlib import Path
import re
import stat
import subprocess

ROOT_UID = 0
SOURCE = "/etc/apparmor.d/bwrap-userns-restrict"
LOCK = "/var/lib/foundry-deploy/lock"
BINARY_PATTERN = re.compile(
    r"/opt/foundry-worker/providers/codex-[0-9]+\.[0-9]+\.[0-9]+"
    r"/node_modules/@openai/codex-linux-(?:x64|arm64)/vendor/"
    r"(?:x86_64|aarch64)-unknown-linux-musl/codex-resources/bwrap"
)


def trusted(root, absolute, executable=False):
    current = root
    for part in Path(absolute).parts[1:]:
        current = current / part
        info = current.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != ROOT_UID or info.st_mode & 0o022:
            raise ValueError(f"Untrusted path component: {current}")
        if current != root / absolute.lstrip("/") and not stat.S_ISDIR(info.st_mode):
            raise ValueError("Non-directory path component")
    info = current.lstat()
    if executable and (not stat.S_ISREG(info.st_mode) or not info.st_mode & 0o111 or info.st_mode & 0o6000):
        raise ValueError("Expected a regular non-setuid root-owned executable")
    return current


def identity(binary):
    if not BINARY_PATTERN.fullmatch(binary):
        raise ValueError("Expected the dedicated, versioned Foundry Codex bwrap path")
    digest = hashlib.sha256(binary.encode()).hexdigest()[:16]
    return f"foundry-codex-bwrap-{digest}"


def render_profile(source, binary):
    name = identity(binary)
    declaration = "profile bwrap /usr/bin/bwrap flags=(attach_disconnected,mediate_deleted) {"
    child = "profile unpriv_bwrap flags=(attach_disconnected,mediate_deleted) {"
    if (source.count(declaration) != 1 or source.count(child) != 1
            or source.count("allow pix /** -> &bwrap//&unpriv_bwrap,") != 1
            or source.count("allow pix /** -> &unpriv_bwrap,") != 1
            or "allow capability," not in source.split(child)[0]
            or "audit deny capability," not in source.split(child)[-1]
            or "allow userns," not in source or "unconfined" in source):
        raise ValueError("Unsupported distro bwrap policy; review its rules before installation")
    payload = source.replace(declaration, f'profile {name} "{binary}" flags=(attach_disconnected,mediate_deleted) {{')
    payload = payload.replace(child, f"profile {name}-child flags=(attach_disconnected,mediate_deleted) {{")
    payload = payload.replace("&bwrap//&unpriv_bwrap", f"&{name}//&{name}-child")
    payload = payload.replace("&unpriv_bwrap", f"&{name}-child")
    checksum = hashlib.sha256(payload.encode()).hexdigest()
    return f"# Foundry Codex bwrap attachment: {binary}\n# Payload SHA256: {checksum}\n{payload}"


def validate_profile(profile):
    subprocess.run(["/usr/sbin/apparmor_parser", "-Q", "-K"], input=profile, text=True, check=True)


def install(root, binary):
    name = identity(binary)
    trusted(root, binary, executable=True)
    source = trusted(root, SOURCE)
    if not source.is_file():
        raise ValueError("Expected the distro policy file")
    profile = render_profile(source.read_text(), binary)
    validate_profile(profile)
    target = source.parent / name
    if target.exists() or target.is_symlink():
        trusted(root, "/" + str(target.relative_to(root)))
        if not target.is_file() or target.read_text() != profile:
            raise ValueError("Refusing to overwrite an existing or changed attachment")
        return target
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    try:
        with os.fdopen(descriptor, "w") as stream:
            os.fchmod(stream.fileno(), 0o644)
            stream.write(profile)
            stream.flush()
            os.fsync(stream.fileno())
    except BaseException:
        target.unlink(missing_ok=True)
        raise
    return target


def remove(root, binary):
    name = identity(binary)
    target = trusted(root, f"/etc/apparmor.d/{name}")
    lines = target.read_text().splitlines(keepends=True)
    if len(lines) < 3 or lines[0] != f"# Foundry Codex bwrap attachment: {binary}\n":
        raise ValueError("Not a managed attachment")
    checksum = hashlib.sha256("".join(lines[2:]).encode()).hexdigest()
    if lines[1] != f"# Payload SHA256: {checksum}\n":
        raise ValueError("Attachment changed; refusing removal")
    target.unlink()
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["install", "remove"])
    parser.add_argument("--binary", required=True)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit("Run with sudo -n; this changes only a dedicated root-owned policy file")
    root = Path("/")
    lock = trusted(root, LOCK)
    with lock.open("r+") as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit("Foundry deployment lock is busy; do not wrap this helper in another lock") from None
        result = install(root, args.binary) if args.action == "install" else remove(root, args.binary)
        print(result)
        print("Kernel policy was not changed. Load/verify or unload under the Foundry deployment lock.")


if __name__ == "__main__":
    main()
