#!/usr/bin/python3
"""Verify/install the fixed, versioned Codex nested-sandbox host policy."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess

DIRECTORY = Path('/usr/local/lib/foundry/sandbox')
EXPECTED = {
    'codex-seccomp-v1.json': '3c8cf53ee38d309e4bd3691b306184c5226e48d60ed593d1d94d00104e534c44',
    'codex-apparmor-v1': '0c874446ada466bcdc6e01dec906d61a4261788bfa50127cb36da21947fd7e3e',
    'codex-apparmor-v2': 'e58cacfe81b9256679c73a9d4d6bbdfd0effaad9b182639a78dd52e68f2c1bc4',
}


def trusted(path):
    for candidate in (path, *path.parents):
        info = candidate.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
            raise RuntimeError('untrusted policy path')
    if not stat.S_ISREG(path.lstat().st_mode):
        raise RuntimeError('policy is not a regular file')


def verify_files(version="2"):
    if Path(__file__).absolute() != DIRECTORY / 'isolation-policy.py':
        raise RuntimeError('helper must be installed at its fixed path')
    trusted(Path(__file__).absolute())
    for name in ["codex-seccomp-v1.json", f"codex-apparmor-v{version}"]:
        digest = EXPECTED[name]
        path = DIRECTORY / name
        trusted(path)
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise RuntimeError('policy content mismatch')
    if Path('/proc/sys/kernel/unprivileged_userns_clone').read_text().strip() != '1':
        raise RuntimeError('unprivileged user namespaces unavailable')
    if int(Path('/proc/sys/user/max_user_namespaces').read_text()) < 1:
        raise RuntimeError('user namespaces unavailable')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['inspect', 'install'])
    parser.add_argument('--version', choices=['1', '2'], default='2')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError('root required')
    verify_files(args.version)
    if args.action == 'install':
        subprocess.run(['/usr/sbin/apparmor_parser', '-r', str(DIRECTORY / f"codex-apparmor-v{args.version}")],
                       check=True, timeout=15)
    profiles = Path('/sys/kernel/security/apparmor/profiles').read_text().splitlines()
    if f"foundry-sandbox-codex-v{args.version} (enforce)" not in profiles:
        raise RuntimeError('required enforcing AppArmor profile unavailable')
    print(json.dumps({'version': args.version, 'seccompSha256': EXPECTED['codex-seccomp-v1.json'],
                      'apparmorSha256': EXPECTED[f"codex-apparmor-v{args.version}"]}))


if __name__ == '__main__':
    try:
        main()
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
        raise SystemExit(f'Sandbox isolation policy rejected: {error}') from None
