#!/usr/bin/env python3
"""Manage only Foundry-owned sandbox bridges and their bounded nftables policy."""
import argparse
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import stat

STATE = Path('/var/lib/foundry-sandbox-networks')
DENIED = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
          '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24',
          '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24',
          '224.0.0.0/4', '240.0.0.0/4']

def run(*args, input=None):
    return subprocess.check_output(args, input=input, text=True, stderr=subprocess.PIPE).strip()

def names(name):
    if not re.fullmatch(r'foundry-sandbox-[a-z0-9-]{1,40}', name):
        raise ValueError('Invalid owned network name')
    suffix = hashlib.sha256(name.encode()).hexdigest()[:10]
    return 'fsb' + suffix, 'fsb_' + suffix

def rules(name, subnet, dns, control):
    interface, table = names(name)
    network = ipaddress.IPv4Network(subnet)
    if not any(network.subnet_of(ipaddress.IPv4Network(block)) for block in ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']) or network.prefixlen < 24 or network.prefixlen > 28:
        raise ValueError('Use an explicit unused private /24 through /28 subnet')
    resolver = ipaddress.IPv4Address(dns)
    if not resolver.is_global:
        raise ValueError('DNS must be an explicit public IPv4 resolver')
    exception = ''
    if control:
        host, port = control.split(':')
        host = ipaddress.IPv4Address(host)
        port = int(port)
        if not 1 <= port <= 65535 or host.is_loopback or host.is_link_local or host.is_multicast:
            raise ValueError('Invalid control endpoint')
        exception = f'ip daddr {host} tcp dport {port} accept;'
    denied = ', '.join(DENIED)
    return f'''table inet {table} {{
 chain input {{ type filter hook input priority -200; policy accept;
  iifname "{interface}" jump sandbox_host;
 }}
 chain sandbox_host {{ {exception} drop; }}
 chain forward {{ type filter hook forward priority -200; policy accept;
  iifname "{interface}" jump sandbox_out;
  oifname "{interface}" ct state established,related accept;
  oifname "{interface}" drop;
 }}
 chain sandbox_out {{
  meta nfproto ipv6 drop;
  {exception}
  ip daddr {{ {denied} }} drop;
  ip daddr {resolver} udp dport 53 accept;
  ip daddr {resolver} tcp dport 53 accept;
  tcp dport 443 accept;
  drop;
 }}
}}
table bridge {table} {{
 chain forward {{ type filter hook forward priority -200; policy accept;
  meta ibrname "{interface}" ether type {{ ip, ip6 }} drop;
 }}
}}
'''

def fingerprint(table):
    values = []
    for family in ['inet', 'bridge']:
        value = json.loads(run('nft', '-j', 'list', 'table', family, table))
        def clean(obj):
            if isinstance(obj, dict):
                return {k: clean(v) for k, v in obj.items() if k not in ['handle', 'metainfo']}
            if isinstance(obj, list):
                return [clean(v) for v in obj if not isinstance(v, dict) or 'metainfo' not in v]
            return obj
        values.append(clean(value))
    return hashlib.sha256(json.dumps(values, sort_keys=True).encode()).hexdigest()

def private_owned(path, directory=False):
    info = path.lstat()
    if info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
        raise ValueError('Policy state must be root-owned and not writable by other users')
    if directory != stat.S_ISDIR(info.st_mode):
        raise ValueError('Unexpected policy state type')

def control_rules(name, control, action):
    if not control:
        return
    interface, table = names(name)
    host, port = control.split(':')
    for chain in ['INPUT', 'FORWARD']:
        run('iptables', '-w', action, chain, '-i', interface, '-d', host,
            '-p', 'tcp', '--dport', port, '-m', 'comment', '--comment', table, '-j', 'ACCEPT')

def inspect(manifest):
    interface, table = names(manifest['name'])
    network = json.loads(run('docker', 'network', 'inspect', manifest['name']))[0]
    if (network['Id'] != manifest['networkId'] or network['Driver'] != 'bridge'
            or network['Options'].get('com.docker.network.bridge.name') != interface
            or network.get('EnableIPv6') or network['Labels'].get('com.foundry.network-policy') != table
            or fingerprint(table) != manifest['fingerprint']):
        raise ValueError('Network policy changed; refuse allocation')
    control_rules(manifest['name'], manifest['control'], '-C')
    return network

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['create', 'inspect', 'remove'])
    parser.add_argument('name')
    parser.add_argument('--subnet')
    parser.add_argument('--dns', default='1.1.1.1')
    parser.add_argument('--control', help='Optional exact Main IPv4:TCP-port exception')
    args = parser.parse_args()
    interface, table = names(args.name)
    if os.geteuid() != 0:
        raise ValueError('Requires operator root privileges')
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    private_owned(STATE, directory=True)
    lock_path = STATE / '.lock'
    with os.fdopen(os.open(lock_path, os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600), 'a') as lock:
        private_owned(lock_path)
        fcntl.flock(lock, fcntl.LOCK_EX)
        path = STATE / (args.name + '.json')
        if path.exists() or path.is_symlink():
            private_owned(path)
        if args.action == 'create' and path.exists():
            manifest = json.loads(path.read_text())
            if (args.subnet, args.dns, args.control) != (manifest['subnet'], manifest['dns'], manifest['control']):
                raise ValueError('Existing policy is pinned; remove empty network first')
            inspect(manifest)
        elif args.action == 'create':
            if not args.subnet:
                raise ValueError('--subnet required')
            script = rules(args.name, args.subnet, args.dns, args.control)
            # Never replace preexisting tables or network, including incomplete operator runs.
            tables = json.loads(run('nft', '-j', 'list', 'tables'))['nftables']
            if any(item.get('table', {}).get('name') == table for item in tables):
                raise ValueError('Owned-name table already exists without manifest; inspect manually')
            existing = run('docker', 'network', 'ls', '--format', '{{.Name}}').splitlines()
            if args.name in existing:
                raise ValueError('Network already exists without manifest')
            run('nft', '-f', '-', input=script)
            try:
                control_rules(args.name, args.control, '-I')
                network_id = run('docker', 'network', 'create', '--driver', 'bridge',
                    '--subnet', args.subnet, '--opt', 'com.docker.network.bridge.name=' + interface,
                    '--opt', 'com.docker.network.bridge.enable_icc=false',
                    '--label', 'com.foundry.egress-policy=restricted-v1',
                    '--label', 'com.foundry.network-policy=' + table,
                    '--label', 'com.foundry.dns=' + args.dns, args.name)
            except BaseException:
                if args.control:
                    for chain in ['INPUT', 'FORWARD']:
                        host, port = args.control.split(':')
                        subprocess.run(['iptables', '-w', '-D', chain, '-i', interface, '-d', host, '-p', 'tcp', '--dport', port, '-m', 'comment', '--comment', table, '-j', 'ACCEPT'], capture_output=True)
                run('nft', '-f', '-', input=f'delete table inet {table}\ndelete table bridge {table}\n')
                raise
            manifest = dict(name=args.name, subnet=args.subnet, dns=args.dns, control=args.control,
                            networkId=network_id, fingerprint=fingerprint(table))
            path.write_text(json.dumps(manifest))
            os.chmod(path, 0o600)
        else:
            manifest = json.loads(path.read_text())
            network = inspect(manifest)
            if args.action == 'remove':
                if network['Containers']:
                    raise ValueError('Refuse removal while containers are attached')
                run('docker', 'network', 'rm', manifest['networkId'])
                control_rules(args.name, manifest['control'], '-D')
                run('nft', '-f', '-', input=f'delete table inet {table}\ndelete table bridge {table}\n')
                path.unlink()
        print(json.dumps({'name': args.name, 'action': args.action, 'verified': True, 'dns': manifest['dns']}))

if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError):
            print(error.stderr, file=sys.stderr)
        sys.exit(1)
