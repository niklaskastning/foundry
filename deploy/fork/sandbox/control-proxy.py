#!/usr/bin/env python3
"""Operator-owned TLS endpoint exposing only Foundry's authenticated machine transport."""
import argparse
import base64
import http.client
import http.server
import ipaddress
import os
from pathlib import Path
import re
import select
import socket
import ssl
import stat
import threading

CHANNEL = '/api/foundry/devices/channel'
STREAM = '/api/foundry/devices/stream'
MAX_BODY = 1024 * 1024

class Proxy(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'FoundrySandboxControl'

    def log_message(self, *_args):
        pass

    def reject(self, status):
        self.send_response(status)
        self.send_header('Content-Length', '0')
        self.send_header('Connection', 'close')
        self.end_headers()
        self.close_connection = True

    def valid_host(self):
        hosts = self.headers.get_all('Host', [])
        return len(hosts) == 1 and hosts[0] in [self.server.hostname, self.server.hostname + ':443']

    def do_POST(self):
        if not self.valid_host() or self.path != CHANNEL:
            return self.reject(404)
        sizes = self.headers.get_all('Content-Length', [])
        if (self.headers.get_all('Transfer-Encoding') or len(sizes) != 1
                or not re.fullmatch(r'[0-9]{1,8}', sizes[0])
                or self.headers.get('Content-Type', '').split(';')[0].strip() != 'application/json'):
            return self.reject(400)
        size = int(sizes[0])
        if size > MAX_BODY:
            return self.reject(413)
        body = self.rfile.read(size)
        if len(body) != size:
            return self.reject(400)
        upstream = http.client.HTTPConnection(*self.server.upstream, timeout=20)
        try:
            upstream.request('POST', CHANNEL, body, {'Host': self.server.hostname,
                'Content-Type': 'application/json', 'Connection': 'close'})
            response = upstream.getresponse()
            result = response.read(4 * MAX_BODY + 1)
            if len(result) > 4 * MAX_BODY or 300 <= response.status < 400:
                return self.reject(502)
            self.send_response(response.status)
            self.send_header('Content-Type', response.getheader('Content-Type', 'application/json'))
            self.send_header('Content-Length', str(len(result)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(result)
            self.close_connection = True
        except (OSError, http.client.HTTPException):
            self.close_connection = True
        finally:
            upstream.close()

    def do_GET(self):
        if not self.valid_host() or self.path not in [CHANNEL, STREAM]:
            return self.reject(404)
        if (self.headers.get('Upgrade', '').lower() != 'websocket'
                or 'upgrade' not in [part.strip().lower() for part in self.headers.get('Connection', '').split(',')]
                or self.headers.get('Sec-WebSocket-Version') != '13'
                or self.headers.get_all('Transfer-Encoding') or self.headers.get_all('Content-Length')):
            return self.reject(400)
        try:
            if len(base64.b64decode(self.headers.get('Sec-WebSocket-Key', ''), validate=True)) != 16:
                return self.reject(400)
        except ValueError:
            return self.reject(400)
        headers = {'Host': self.server.hostname, 'Connection': 'Upgrade', 'Upgrade': 'websocket',
                   'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': self.headers['Sec-WebSocket-Key']}
        if self.path == STREAM:
            ticket = self.headers.get('x-foundry-stream-ticket', '')
            if not re.fullmatch(r'[A-Za-z0-9_-]{1,4096}', ticket):
                return self.reject(403)
            headers['x-foundry-stream-ticket'] = ticket
        upstream = socket.create_connection(self.server.upstream, timeout=10)
        try:
            request = f'GET {self.path} HTTP/1.1\r\n' + ''.join(f'{key}: {value}\r\n' for key, value in headers.items()) + '\r\n'
            upstream.sendall(request.encode('ascii'))
            response = bytearray()
            while b'\r\n\r\n' not in response:
                chunk = upstream.recv(4096)
                if not chunk or len(response) + len(chunk) > 16384:
                    return self.reject(502)
                response.extend(chunk)
            header, remainder = bytes(response).split(b'\r\n\r\n', 1)
            if not header.startswith(b'HTTP/1.1 101 '):
                return self.reject(403)
            accepted = []
            for line in header.split(b'\r\n')[1:]:
                name, separator, value = line.partition(b':')
                if separator and name.lower() in [b'upgrade', b'connection', b'sec-websocket-accept', b'sec-websocket-protocol']:
                    accepted.append(name + b':' + value)
            self.connection.sendall(b'HTTP/1.1 101 Switching Protocols\r\n' + b'\r\n'.join(accepted) + b'\r\n\r\n' + remainder)
            self.close_connection = True
            while not self.server.stopping.is_set():
                buffered = self.connection.pending() > 0
                ready, _, _ = select.select([self.connection, upstream], [], [], 0 if buffered else 1)
                if buffered and self.connection not in ready:
                    ready.append(self.connection)
                for source in ready:
                    chunk = source.recv(65536)
                    if not chunk:
                        return
                    (upstream if source is self.connection else self.connection).sendall(chunk)
        except (OSError, ValueError, UnicodeError):
            self.close_connection = True
        finally:
            upstream.close()

    def do_HEAD(self):
        self.reject(405)
    do_PUT = do_HEAD
    do_DELETE = do_HEAD
    do_OPTIONS = do_HEAD
    do_PATCH = do_HEAD
    do_CONNECT = do_HEAD

class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 16

    def __init__(self, address, hostname, upstream, context):
        self.hostname = hostname
        self.upstream = upstream
        self.context = context
        self.stopping = threading.Event()
        # 32 allocations each hold one channel and four streams; reserve 64 HTTP/handshake slots.
        self.slots = threading.BoundedSemaphore(32 * (1 + 4) + 64)
        super().__init__(address, Proxy)

    def get_request(self):
        client, address = super().get_request()
        client.settimeout(10)
        return client, address

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            request.close()
            return
        super().process_request(request, client_address)

    def process_request_thread(self, request, client_address):
        try:
            with self.context.wrap_socket(request, server_side=True) as secured:
                super().process_request_thread(secured, client_address)
        except (OSError, ssl.SSLError):
            request.close()
        finally:
            self.slots.release()

    def server_close(self):
        self.stopping.set()
        super().server_close()

def owned_file(path, secret=False):
    info = Path(path).lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & (0o077 if secret else 0o022):
        raise ValueError('TLS files must be root-owned regular files with restricted permissions')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--listen', required=True, help='Own bridge IPv4 address; port is always 443')
    parser.add_argument('--hostname', required=True)
    parser.add_argument('--upstream-port', required=True, type=int)
    parser.add_argument('--certificate', required=True)
    parser.add_argument('--key', required=True)
    args = parser.parse_args()
    address = ipaddress.IPv4Address(args.listen)
    if not any(address in ipaddress.IPv4Network(block) for block in ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']) or not 1 <= args.upstream_port <= 65535:
        parser.error('Own private bridge IPv4 and valid loopback Main port required')
    if not re.fullmatch(r'(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+', args.hostname):
        parser.error('Canonical DNS hostname required')
    owned_file(args.certificate)
    owned_file(args.key, secret=True)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(args.certificate, args.key)
    with Server((args.listen, 443), args.hostname, ('127.0.0.1', args.upstream_port), context) as server:
        server.serve_forever()

if __name__ == '__main__':
    main()
