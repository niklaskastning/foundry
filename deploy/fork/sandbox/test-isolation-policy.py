#!/usr/bin/python3
"""Bounded real Codex command/exec policy checks; no auth or provider/model turns."""
import argparse
import base64
import json
from pathlib import Path
import re
import subprocess
import uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--image', required=True)
args = parser.parse_args()
if not re.fullmatch(r'[a-zA-Z0-9._:/-]+@sha256:[a-f0-9]{64}', args.image):
    parser.error('image must be immutable')
helper = '/usr/local/lib/foundry/sandbox/isolation-policy.py'
subprocess.run(['/usr/bin/python3', helper, 'inspect'], check=True, timeout=15)
script = base64.b64encode(Path(__file__).with_name('codex-isolation-probe.mjs').read_bytes()).decode()
command = ('set -eu; test ! -e /var/run/docker.sock; test ! -e /home/niklas/.t3/userdata; '
           "awk '/^(CapEff|CapBnd):/ {if ($2 != \"0000000000000000\") exit 1; caps++} "
           "/^NoNewPrivs:/ {if ($2 != 1) exit 1; nnp++} "
           "/^Seccomp:/ {if ($2 != 2) exit 1; seccomp++} "
           "END {if (caps != 2 || nnp != 1 || seccomp != 1) exit 1}' /proc/self/status; "
           'if mount -o remount,rw /; then exit 9; fi; '
           'printf %s ' + script + ' | base64 -d > /tmp/isolation-probe.mjs && '
           'node /tmp/isolation-probe.mjs')
name = 'foundry-sandbox-policy-probe-' + uuid.uuid4().hex[:12]
container = None
volume = name + '-workspace'
try:
    subprocess.run(['docker', 'volume', 'create', '--label',
                    'com.foundry.acceptance=isolation-policy-v1', volume],
                   check=True, stdout=subprocess.DEVNULL, timeout=15)
    container = subprocess.check_output([
        'docker', 'create', '--name', name, '--label', 'com.foundry.acceptance=isolation-policy-v1',
        '--network=none', '--user=1000:1000', '--read-only', '--cap-drop=ALL',
        '--security-opt=no-new-privileges:true',
        '--security-opt=seccomp=/usr/local/lib/foundry/sandbox/codex-seccomp-v1.json',
        '--security-opt=apparmor=foundry-sandbox-codex-v2', '--pids-limit=128',
        '--memory=512m', '--memory-swap=512m', '--cpus=1', '--log-driver=none',
        '--tmpfs=/tmp:rw,nosuid,nodev,size=67108864,mode=1777',
        '--tmpfs=/run:rw,nosuid,nodev,noexec,size=16777216,uid=1000,gid=1000,mode=0700',
        '--mount=type=volume,src=' + volume + ',dst=/workspace',
        '--workdir=/workspace', '--entrypoint=/bin/sh', args.image, '-c', command,
    ], text=True, timeout=20).strip()
    result = subprocess.run(['docker', 'start', '--attach', container],
                            text=True, capture_output=True, timeout=30)
    print(json.dumps({'name': name, 'exit': result.returncode,
                      'stdout': result.stdout[:8192], 'stderr': result.stderr[:4096]}))
    if result.returncode:
        raise SystemExit('actual Codex isolation probe failed')
finally:
    if not container:
        inspected = subprocess.run(['docker', 'inspect', '--format', '{{json .}}', name],
                                   text=True, capture_output=True, timeout=10)
        if inspected.returncode == 0:
            own = json.loads(inspected.stdout)
            if (own.get('Name') == '/' + name and
                    own.get('Config', {}).get('Labels', {}).get('com.foundry.acceptance') ==
                    'isolation-policy-v1'):
                container = own['Id']
    if container:
        subprocess.run(['docker', 'stop', '--timeout', '2', container],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        subprocess.run(['docker', 'rm', container], check=True,
                       stdout=subprocess.DEVNULL, timeout=10)

    inspected_volume = subprocess.run(['docker', 'volume', 'inspect', volume],
                                      text=True, capture_output=True, timeout=10)
    if inspected_volume.returncode == 0:
        own = json.loads(inspected_volume.stdout)[0]
        if (own.get('Name') == volume and
                own.get('Labels', {}).get('com.foundry.acceptance') == 'isolation-policy-v1'):
            subprocess.run(['docker', 'volume', 'rm', volume], check=True,
                           stdout=subprocess.DEVNULL, timeout=10)
