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
PROFILE = 'foundry-sandbox-codex-v1'
EXPECTED = {
    'codex-seccomp-v1.json': '3c8cf53ee38d309e4bd3691b306184c5226e48d60ed593d1d94d00104e534c44',
    'codex-apparmor-v1': '0c874446ada466bcdc6e01dec906d61a4261788bfa50127cb36da21947fd7e3e',
}


def trusted(path):
    for candidate in (path, *path.parents):
        info = candidate.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
            raise RuntimeError('untrusted policy path')
    if not stat.S_ISREG(path.lstat().st_mode):
        raise RuntimeError('policy is not a regular file')


def verify_files():
    if Path(__file__).absolute() != DIRECTORY / 'isolation-policy.py':
        raise RuntimeError('helper must be installed at its fixed path')
    trusted(Path(__file__).absolute())
    for name, digest in EXPECTED.items():
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
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError('root required')
    verify_files()
    if args.action == 'install':
        subprocess.run(['/usr/sbin/apparmor_parser', '-r', str(DIRECTORY / 'codex-apparmor-v1')],
                       check=True, timeout=15)
    profiles = Path('/sys/kernel/security/apparmor/profiles').read_text().splitlines()
    if f'{PROFILE} (enforce)' not in profiles:
        raise RuntimeError('required enforcing AppArmor profile unavailable')
    print(json.dumps({'version': '1', 'seccompSha256': EXPECTED['codex-seccomp-v1.json'],
                      'apparmorSha256': EXPECTED['codex-apparmor-v1']}))


if __name__ == '__main__':
    try:
        main()
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
        raise SystemExit(f'Sandbox isolation policy rejected: {error}') from None
