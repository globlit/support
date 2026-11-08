#!/usr/bin/env python3
"""Fixed vsock API relay and loopback HTTP proxy. No host filesystem or commands."""
import argparse
import json
import re
import select
import socket
import socketserver
import threading
import time
from urllib.parse import urlsplit

HOST_CID = 2
API_PORT = 4173
EGRESS_PORT = 4174
PROXY_PORT = 18080


def relay(left, right, initial=b'', deadline=600, max_bytes=64 * 1024 * 1024):
    left.settimeout(5)
    right.settimeout(5)
    if initial:
        right.sendall(initial)
    end = time.monotonic() + deadline
    total = len(initial)
    active = {left: right, right: left}
    while active and time.monotonic() < end:
        ready, _, _ = select.select(list(active), [], [], min(1, max(0, end - time.monotonic())))
        for source in ready:
            data = source.recv(32768)
            if not data:
                target = active.pop(source)
                try:
                    target.shutdown(socket.SHUT_WR)
                except OSError:
                    pass
                continue
            total += len(data)
            if total > max_bytes:
                raise ValueError('stream limit')
            active[source].sendall(data)


def authority(host, port):
    if not isinstance(host, str) or not re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?', host) or '..' in host:
        raise ValueError('invalid host')
    if not isinstance(port, int) or not 1 <= port <= 65535:
        raise ValueError('invalid port')
    return host, port


def proxy_target(header):
    lines = header.decode('ascii').split('\r\n')
    if len(lines) > 102:
        raise ValueError('too many headers')
    method, target, version = lines[0].split(' ')
    if version not in ('HTTP/1.0', 'HTTP/1.1') or not re.fullmatch(r'[A-Z]{1,16}', method):
        raise ValueError('invalid request')
    if method == 'CONNECT':
        if not re.fullmatch(r'[A-Za-z0-9.-]+:[0-9]{1,5}', target):
            raise ValueError('invalid CONNECT authority')
        host, port = target.rsplit(':', 1)
        return (*authority(host.lower(), int(port)), None)
    url = urlsplit(target)
    if url.scheme != 'http' or not url.hostname or url.username or url.password or url.fragment:
        raise ValueError('absolute HTTP URL required')
    host, port = authority(url.hostname.lower(), url.port or 80)
    path = url.path or '/'
    if url.query:
        path += '?' + url.query
    # A single request per connection avoids proxy cross-authority pipelining.
    kept = []
    for line in lines[1:]:
        if not line:
            continue
        if ':' not in line or line[0] in ' \t':
            raise ValueError('invalid header')
        name = line.split(':', 1)[0].lower()
        if name not in ('proxy-authorization', 'proxy-connection', 'connection', 'host'):
            kept.append(line)
    forwarded = f'{method} {path} {version}\r\nHost: {host}:{port}\r\nConnection: close\r\n' + '\r\n'.join(kept) + '\r\n\r\n'
    return host, port, forwarded.encode('ascii')


def connect_egress(host, port):
    peer = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    try:
        peer.settimeout(5)
        peer.connect((HOST_CID, EGRESS_PORT))
        peer.sendall(json.dumps({'version': 1, 'host': host, 'port': port}, separators=(',', ':')).encode() + b'\n')
        # Read only the status, preserving any remote application bytes after it.
        status = b''
        while not status.endswith(b'\n') and len(status) < 16:
            part = peer.recv(1)
            if not part:
                raise ValueError('broker closed')
            status += part
        if status != b'OK\n':
            raise ValueError('destination not approved')
        return peer
    except Exception:
        peer.close()
        raise


class ProxyHandler(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            self.request.settimeout(5)
            head = b''
            while b'\r\n\r\n' not in head:
                chunk = self.request.recv(1024)
                if not chunk:
                    return
                head += chunk
                if len(head) > 16384:
                    raise ValueError('header too large')
            header, body = head.split(b'\r\n\r\n', 1)
            host, port, forward = proxy_target(header)
            with connect_egress(host, port) as peer:
                if forward is None:
                    # CONNECT payload must start after the explicit success response.
                    if body:
                        raise ValueError('early tunnel payload')
                    self.request.sendall(b'HTTP/1.1 200 Connection Established\r\n\r\n')
                relay(self.request, peer, (forward or b'') + body)
        except (OSError, ValueError, UnicodeError):
            try:
                self.request.sendall(b'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
            except OSError:
                pass


class APIHandler(socketserver.BaseRequestHandler):
    def handle(self):
        if self.client_address[0] != HOST_CID:
            return
        try:
            with socket.create_connection(('127.0.0.1', API_PORT), timeout=5) as app:
                relay(self.request, app, deadline=120, max_bytes=8 * 1024 * 1024)
        except (OSError, ValueError):
            pass


class BoundedServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = False
    request_queue_size = 8
    def __init__(self, address, handler):
        self.slots = threading.BoundedSemaphore(8)
        super().__init__(address, handler)
    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise
    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


class VsockServer(BoundedServer):
    address_family = socket.AF_VSOCK


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['api', 'proxy'])
    args = parser.parse_args()
    server = VsockServer((socket.VMADDR_CID_ANY, API_PORT), APIHandler) if args.mode == 'api' else BoundedServer(('127.0.0.1', PROXY_PORT), ProxyHandler)
    with server:
        server.serve_forever(poll_interval=0.5)
