#!/usr/bin/env python3
"""Real, isolated network acceptance; removes only IDs created by this process."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
import socket
import hashlib
import uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--image', required=True, help='Existing immutable Linux image containing Node')
args = parser.parse_args()
if not re.fullmatch(r'[a-zA-Z0-9._:/-]+@sha256:[a-f0-9]{64}', args.image):
    parser.error('Image must be pinned by digest')
suffix = uuid.uuid4().hex[:12]
network = 'foundry-sandbox-test-' + suffix
other_network = 'foundry-sandbox-peer-' + suffix
policy = str(Path(__file__).with_name('network-policy.py'))
containers = []
servers = []
created = []
with socket.socket() as reservation:
    reservation.bind(('127.0.0.1', 0))
    control_port = reservation.getsockname()[1]
with socket.socket() as reservation:
    reservation.bind(('127.0.0.1', 0))
    blocked_port = reservation.getsockname()[1]

def run(*command):
    result = subprocess.run(command, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stdout + result.stderr)
    return result.stdout.strip()

def docker(*command):
    return run('docker', *command)

def start(network_name):
    container = docker('run', '-d', '--label', 'com.foundry.network-fixture=' + suffix,
        '--network', network_name, '--dns', '1.1.1.1', '--cap-drop=ALL',
        '--security-opt=no-new-privileges', '--read-only', '--user', '1000:1000',
        '--entrypoint', 'node', args.image, '-e',
        'require("http").createServer((q,s)=>s.end("own fixture")).listen(443,"0.0.0.0",()=>console.log("READY"));')
    containers.append(container)
    logs = subprocess.Popen(['docker', 'logs', '--follow', container], stdout=subprocess.PIPE, text=True)
    try:
        if logs.stdout.readline().strip() != 'READY':
            raise RuntimeError('Fixture server failed to start')
    finally:
        logs.terminate()
        logs.wait()
    address = json.loads(docker('inspect', container))[0]['NetworkSettings']['Networks'][network_name]['IPAddress']
    docker('exec', container, 'node', '-e', 'const s=require("net").connect(443,"127.0.0.1",()=>s.end());s.on("error",()=>process.exit(1));')
    return container, address

try:
    # Docker rejects overlapping subnets; a busy fixture range causes a clean refusal.
    docker('network', 'create', '--subnet', '172.30.242.0/28', '--label', 'com.foundry.network-fixture=' + suffix, other_network)
    created.append(other_network)
    _, other = start(other_network)
    run('python3', policy, 'create', network, '--subnet', '172.30.241.0/28', '--control', f'172.30.241.1:{control_port}')
    created.append(network)
    print(run('python3', policy, 'create', network, '--subnet', '172.30.241.0/28', '--control', f'172.30.241.1:{control_port}'))
    first, _ = start(network)
    _, peer = start(network)
    for port in [control_port, blocked_port]:
        server = subprocess.Popen([sys.executable, '-u', '-c',
            'import socket,sys;s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(("172.30.241.1",int(sys.argv[1])));s.listen();print("READY",flush=True)\nwhile True:\n c,a=s.accept();c.close()', str(port)], stdout=subprocess.PIPE, text=True)
        servers.append(server)
        if server.stdout.readline().strip() != 'READY':
            raise RuntimeError('Host fixture failed to start')
    targets = [['peer', peer, 443, False], ['other-container', other, 443, False],
        ['control', '172.30.241.1', control_port, True], ['host-other-port', '172.30.241.1', blocked_port, False],
        ['metadata', '169.254.169.254', 80, False], ['private', '10.0.0.1', 443, False],
        ['cgnat', '100.100.100.200', 443, False], ['other-dns', '8.8.8.8', 53, False],
        ['public-http', '1.1.1.1', 80, False], ['public-https', '1.1.1.1', 443, True]]
    script = r'''
const net=require('net'),dns=require('dns').promises,https=require('https');
const tcp=(host,port)=>new Promise(resolve=>{const s=net.connect({host,port});s.setTimeout(1600);s.once('connect',()=>{s.destroy();resolve(true)});s.once('error',()=>resolve(false));s.once('timeout',()=>{s.destroy();resolve(false)});});
const get=url=>new Promise((resolve,reject)=>https.get(url,{timeout:6000},r=>{r.destroy();resolve(r.statusCode)}).on('error',reject).on('timeout',function(){this.destroy(new Error('timeout'))}));
(async()=>{const results=await Promise.all(JSON.parse(process.argv[1]).map(async([name,host,port,expected])=>({name,connected:await tcp(host,port),expected})));const lookup=await dns.lookup('github.com');const github=await get('https://github.com');const openai=await get('https://api.openai.com/v1/models');console.log(JSON.stringify({results,dns:lookup.address,github,openai}));if(results.some(r=>r.connected!==r.expected)||github!==200||openai!==401)process.exitCode=1;})().catch(e=>{console.error(e.message);process.exitCode=1;});
'''
    print(docker('exec', first, 'node', '-e', script, json.dumps(targets)))
    print(run('python3', policy, 'inspect', network))
    table = 'fsb_' + hashlib.sha256(network.encode()).hexdigest()[:10]
    saved = run('nft', 'list', 'table', 'inet', table)
    try:
        run('nft', 'add', 'rule', 'inet', table, 'sandbox_out', 'counter')
        changed = subprocess.run(['python3', policy, 'inspect', network], capture_output=True, text=True)
        if changed.returncode == 0 or 'Network policy changed' not in changed.stderr:
            raise RuntimeError('Changed firewall was not rejected')
    finally:
        subprocess.run(['nft', '-f', '-'], input=f'delete table inet {table}\n{saved}\n', text=True, check=True)
    print(run('python3', policy, 'inspect', network))
    refusal = subprocess.run(['python3', policy, 'remove', network], capture_output=True, text=True)
    if refusal.returncode == 0 or 'containers are attached' not in refusal.stderr:
        raise RuntimeError('Attached-network deletion was not refused')
finally:
    for server in servers:
        server.terminate()
        server.wait()
    for container in reversed(containers):
        docker('rm', '-f', container)
    for name in reversed(created):
        if name == network:
            print(run('python3', policy, 'remove', name))
        else:
            docker('network', 'rm', name)

interface = 'fsb' + hashlib.sha256(network.encode()).hexdigest()[:10]
if interface in run('iptables', '-S', 'INPUT') or interface in run('iptables', '-S', 'FORWARD'):
    raise RuntimeError('Own control rules leaked after cleanup')
if table in run('nft', 'list', 'tables') or network in docker('network', 'ls', '--format', '{{.Name}}'):
    raise RuntimeError('Own policy table or network leaked after cleanup')
print(json.dumps({'cleanup': 'verified', 'network': network}))
