#!/usr/bin/env python3
"""Local TLS transport fixtures; no deployed services, credentials or network access."""
import base64
from contextlib import contextmanager, ExitStack
import hashlib
import http.client
import http.server
import importlib.util
from pathlib import Path
import socket
import ssl
import subprocess
import tempfile
import sys
import os
import threading
import unittest

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('control_proxy', Path(__file__).with_name('control-proxy.py'))
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)
HOST = 'foundry-fixture.test'

@contextmanager
def serving(server):
    thread = threading.Thread(target=server.serve_forever)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join()

class Upstream(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *_args):
        pass
    def do_POST(self):
        self.server.seen.append((self.path, dict(self.headers)))
        body = self.rfile.read(int(self.headers['Content-Length']))
        self.send_response(200 if body == b'{"proof":"fixture-valid"}' else 403)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', '2')
        self.end_headers()
        self.wfile.write(b'{}')
    def do_GET(self):
        self.server.seen.append((self.path, dict(self.headers)))
        if self.path == proxy.STREAM and self.headers.get('x-foundry-stream-ticket') != 'fixture-ticket':
            self.send_response(403)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        accept = base64.b64encode(hashlib.sha1((self.headers['Sec-WebSocket-Key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
        self.send_response(101)
        self.send_header('Upgrade', 'websocket')
        self.send_header('Connection', 'Upgrade')
        self.send_header('Sec-WebSocket-Accept', accept)
        self.send_header('Set-Cookie', 'must-not-forward=fixture')
        self.end_headers()
        self.wfile.write(b'\x81\x05ready')
        prefix = self.rfile.read(2)
        mask = self.rfile.read(4)
        data = self.rfile.read(2)
        if prefix == b'\x81\x82' and len(mask) == 4 and bytes(value ^ mask[index % 4] for index, value in enumerate(data)) == b'ok':
            self.wfile.write(b'\x81\x02ok\x81\x05later')
            self.wfile.flush()
        self.close_connection = True

class ControlProxyTest(unittest.TestCase):
    def test_tls_routes_bodies_and_websocket_isolation(self):
        with tempfile.TemporaryDirectory(prefix='foundry-control-proxy-') as directory:
            cert = Path(directory) / 'certificate.pem'
            key = Path(directory) / 'key.pem'
            subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=' + HOST, '-addext', 'subjectAltName=DNS:' + HOST + ',IP:127.0.0.1', '-keyout', str(key), '-out', str(cert)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            server_context.load_cert_chain(cert, key)
            trusted = ssl.create_default_context(cafile=str(cert))
            upstream = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
            upstream.seen = []
            upstream.daemon_threads = True
            with serving(upstream), serving(proxy.Server(('127.0.0.1', 0), HOST, upstream.server_address, server_context)) as gateway:
                def connect(context=trusted):
                    raw = socket.create_connection(gateway.server_address, timeout=3)
                    try:
                        return context.wrap_socket(raw, server_hostname=HOST)
                    except BaseException:
                        raw.close()
                        raise
                def request(method, path, headers=None, body=b''):
                    with connect() as stream:
                        values = {'Host': HOST, 'Connection': 'close', **(headers or {})}
                        head = f'{method} {path} HTTP/1.1\r\n' + ''.join(f'{key}: {value}\r\n' for key, value in values.items()) + '\r\n'
                        stream.sendall(head.encode() + body)
                        response = http.client.HTTPResponse(stream)
                        response.begin()
                        result = (response.status, response.read())
                        response.close()
                        return result
                with self.assertRaises(ssl.SSLCertVerificationError):
                    connect(ssl.create_default_context())
                node_script = "fetch(process.argv[1],{method:'POST',headers:{host:'foundry-fixture.test','content-type':'application/json'},body:JSON.stringify({proof:'fixture-valid'})}).then(r=>process.exit(r.status===404?0:3)).catch(()=>process.exit(2))"
                endpoint = f'https://127.0.0.1:{gateway.server_port}{proxy.CHANNEL}'
                for ca, expected in [(None, 2), (str(cert), 0)]:
                    environment = {'PATH':os.environ['PATH'], 'HOME':directory}
                    if ca:
                        environment['NODE_EXTRA_CA_CERTS'] = ca
                    completed = subprocess.run(['node','-e',node_script,endpoint], env=environment, capture_output=True, timeout=10)
                    self.assertEqual(completed.returncode, expected, completed.stderr.decode())
                node_https = "const body=JSON.stringify({proof:'fixture-valid'});const r=require('node:https').request({hostname:'foundry-fixture.test',port:new URL(process.argv[1]).port,path:'/api/foundry/devices/channel',method:'POST',lookup:(h,o,cb)=>o.all?cb(null,[{address:'127.0.0.1',family:4}]):cb(null,'127.0.0.1',4),headers:{host:'foundry-fixture.test','content-type':'application/json','content-length':Buffer.byteLength(body)}},r=>{r.resume();r.on('end',()=>process.exit(r.statusCode===200?0:3));});r.on('error',()=>process.exit(2));r.end(body);"
                completed = subprocess.run(['node','-e',node_https,endpoint], env={'PATH':os.environ['PATH'],'HOME':directory,'NODE_EXTRA_CA_CERTS':str(cert)},capture_output=True,timeout=10)
                self.assertEqual(completed.returncode, 0)
                body = b'{"proof":"fixture-valid"}'
                headers = {'Content-Type': 'application/json', 'Content-Length': str(len(body)), 'Cookie': 'private=fixture', 'Authorization': 'Bearer fixture', 'CF-Access-Client-Secret': 'fixture'}
                self.assertEqual(request('POST', proxy.CHANNEL, headers, body)[0], 200)
                for forbidden in ['Cookie', 'Authorization', 'CF-Access-Client-Secret']:
                    self.assertNotIn(forbidden, upstream.seen[-1][1])
                self.assertEqual(upstream.seen[-1][1]['Host'], HOST)
                self.assertEqual(request('POST', proxy.CHANNEL, {'Content-Type':'application/json', 'Content-Length':'2'}, b'{}')[0], 403)
                before = len(upstream.seen)
                self.assertEqual(request('POST', proxy.CHANNEL, {**headers, 'Host':'foreign.test'}, body)[0], 404)
                self.assertEqual(request('POST', proxy.CHANNEL + '?other=1', headers, body)[0], 404)
                self.assertEqual(request('POST', '/api/foundry/sandboxes', headers, body)[0], 404)
                self.assertEqual(request('DELETE', proxy.CHANNEL)[0], 405)
                self.assertEqual(request('POST', proxy.CHANNEL, {**headers, 'Content-Length':str(proxy.MAX_BODY + 1)})[0], 413)
                self.assertEqual(request('POST', proxy.CHANNEL, {**headers, 'Transfer-Encoding':'chunked'})[0], 400)
                self.assertEqual(request('GET', proxy.CHANNEL)[0], 400)
                self.assertEqual(len(upstream.seen), before)
                websocket = {'Upgrade':'websocket', 'Connection':'Upgrade', 'Sec-WebSocket-Version':'13', 'Sec-WebSocket-Key':base64.b64encode(b'0123456789abcdef').decode()}
                self.assertEqual(request('GET', proxy.STREAM, websocket)[0], 403)
                self.assertEqual(request('GET', proxy.STREAM, {**websocket,'x-foundry-stream-ticket':'wrong'})[0], 403)
                # Five real persistent sockets plus reserved permits model 32 occupied allocations.
                with ExitStack() as persistent:
                    for path in [proxy.CHANNEL] + [proxy.STREAM] * 4:
                        stream = persistent.enter_context(connect())
                        values = {'Host':HOST, **websocket, 'x-foundry-stream-ticket':'fixture-ticket'}
                        stream.sendall((f'GET {path} HTTP/1.1\r\n' + ''.join(f'{k}: {v}\r\n' for k,v in values.items()) + '\r\n').encode())
                        header = bytearray()
                        while b'\r\n\r\n' not in header:
                            header.extend(stream.recv(1))
                        self.assertTrue(header.startswith(b'HTTP/1.1 101 '))
                        self.assertEqual(stream.recv(7), b'\x81\x05ready')
                    acquired = 0
                    try:
                        for _ in range(31 * 5):
                            self.assertTrue(gateway.slots.acquire(blocking=False))
                            acquired += 1
                        self.assertEqual(request('POST', proxy.CHANNEL, headers, body)[0], 200)
                    finally:
                        for _ in range(acquired):
                            gateway.slots.release()
                node_ws = """
import {NodeWS} from '@effect/platform-node/NodeSocket';
const lookup=(h,o,cb)=>o.all?cb(null,[{address:'127.0.0.1',family:4}]):cb(null,'127.0.0.1',4);
for(const path of ['/api/foundry/devices/channel','/api/foundry/devices/stream']) await new Promise((resolve,reject)=>{
 const ws=new NodeWS.WebSocket(`wss://foundry-fixture.test:${process.argv[1]}${path}`,{lookup,followRedirects:false,handshakeTimeout:3000,maxPayload:path.endsWith('stream')?262144:131072,perMessageDeflate:false,headers:{Host:'foundry-fixture.test',...(path.endsWith('stream')?{'x-foundry-stream-ticket':'fixture-ticket'}:{})}});
 const messages=[];ws.on('error',reject);ws.on('message',data=>{messages.push(String(data));if(String(data)==='ready')ws.send('ok');if(messages.length===3){ws.terminate();if(messages.join(',')==='ready,ok,later')resolve();else reject(new Error('frame corruption'));}});
 ws.on('close',()=>{if(messages.length!==3)reject(new Error('early close'));});
});
"""
                completed = subprocess.run(['node','--input-type=module','-e',node_ws,str(gateway.server_port)],cwd=Path(__file__).resolve().parents[3] / 'apps/server',env={'PATH':os.environ['PATH'],'HOME':directory,'NODE_EXTRA_CA_CERTS':str(cert)},capture_output=True,timeout=10)
                self.assertEqual(completed.returncode, 0, completed.stderr.decode())
                for path in [proxy.CHANNEL, proxy.STREAM]:
                    with connect() as stream:
                        values = {'Host':HOST, **websocket, 'x-foundry-stream-ticket':'fixture-ticket'}
                        stream.sendall((f'GET {path} HTTP/1.1\r\n' + ''.join(f'{k}: {v}\r\n' for k,v in values.items()) + '\r\n').encode())
                        header = bytearray()
                        while b'\r\n\r\n' not in header:
                            header.extend(stream.recv(1))
                        self.assertTrue(header.startswith(b'HTTP/1.1 101 '))
                        self.assertNotIn(b'Set-Cookie', header)
                        self.assertEqual(stream.recv(7), b'\x81\x05ready')
                        stream.sendall(b'\x81\x82\x00\x00\x00\x00ok')
                        frames = bytearray()
                        while len(frames) < 11:
                            frames.extend(stream.recv(11-len(frames)))
                        self.assertEqual(frames, b'\x81\x02ok\x81\x05later')

if __name__ == '__main__':
    unittest.main()
