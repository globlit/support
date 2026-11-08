import importlib.util
import pathlib
import socket
import threading
import unittest
import tempfile
import gzip
import runpy
import os
import subprocess
ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('bridge', ROOT/'deployment/managed/guest-bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

class BridgeTests(unittest.TestCase):
    def test_node_fetch_honors_guest_proxy_environment(self):
        original=bridge.connect_egress
        calls=[];workers=[]
        def connect(host,port):
            calls.append((host,port));a,b=socket.socketpair()
            def respond():
                with b:
                    b.settimeout(5);head=b''
                    while b'\r\n\r\n' not in head: head+=b.recv(4096)
                    b.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nproxied')
            worker=threading.Thread(target=respond);worker.start();workers.append(worker);return a
        bridge.connect_egress=connect
        server=bridge.BoundedServer(('127.0.0.1',0),bridge.ProxyHandler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            env={k:v for k,v in os.environ.items() if k.lower() not in ['http_proxy','https_proxy','all_proxy','no_proxy','node_options']}
            env.update(HTTP_PROXY='http://127.0.0.1:'+str(server.server_address[1]),HTTPS_PROXY='http://127.0.0.1:'+str(server.server_address[1]),NO_PROXY='127.0.0.1,localhost',NODE_USE_ENV_PROXY='1')
            result=subprocess.run(['node','--input-type=module','-e',"const r=await fetch('http://api.company.test/check',{signal:AbortSignal.timeout(4000)});process.stdout.write(await r.text());"],env=env,capture_output=True,text=True,timeout=8,check=True)
            self.assertEqual(result.stdout,'proxied');self.assertEqual(calls,[('api.company.test',80)])
        finally:
            server.shutdown();server.server_close();bridge.connect_egress=original
            for worker in workers:worker.join(6)
    def test_kernel_bundle_rejects_wrong_formats_and_normalizes_arm64(self):
        prepare=runpy.run_path(str(ROOT/'deployment/managed/prepare-kernel.py'))['prepare']
        with tempfile.TemporaryDirectory() as folder:
            source=pathlib.Path(folder)/'kernel';target=pathlib.Path(folder)/'image'
            raw=bytearray(1024);raw[56:60]=b'ARM\x64'
            source.write_bytes(gzip.compress(raw));prepare(source,target,'arm64');self.assertEqual(target.read_bytes(),raw)
            source.write_bytes(raw);prepare(source,target,'arm64');self.assertEqual(target.read_bytes(),raw)
            with self.assertRaises(ValueError):prepare(source,target,'x86_64')
            raw[56:60]=b'\0'*4;raw[514:518]=b'HdrS';source.write_bytes(raw);prepare(source,target,'x86_64')
            with self.assertRaises(ValueError):prepare(source,target,'arm64')
            source.write_bytes(b'not a kernel')
            with self.assertRaises(ValueError):prepare(source,target,'arm64')
    def test_connect_authority_is_strict(self):
        self.assertEqual(bridge.proxy_target(b'CONNECT gitlab.company.test:443 HTTP/1.1\r\nHost: gitlab.company.test'), ('gitlab.company.test',443,None))
        for target in [b'localhost/path:443',b'gitlab.test:99999',b'[::1]:443',b'gitlab.test:443@localhost',b'gitlab.test:443?x']:
            with self.assertRaises(ValueError): bridge.proxy_target(b'CONNECT '+target+b' HTTP/1.1')
    def test_plain_http_drops_proxy_credentials_and_uses_pinned_authority(self):
        host, port, request = bridge.proxy_target(b'POST http://youtrack.company.test/api/issues?q=1 HTTP/1.1\r\nHost: evil\r\nProxy-Authorization: secret\r\nContent-Length: 2')
        self.assertEqual((host,port),('youtrack.company.test',80))
        self.assertTrue(request.startswith(b'POST /api/issues?q=1 HTTP/1.1\r\nHost: youtrack.company.test:80'))
        self.assertNotIn(b'secret',request)
        self.assertNotIn(b'evil',request)
        with self.assertRaises(ValueError): bridge.proxy_target(b'GET file:///etc/passwd HTTP/1.1')
        with self.assertRaises(ValueError): bridge.proxy_target(b'GET http://user:pass@service/ HTTP/1.1')
    def test_relay_preserves_bidirectional_data_and_half_close(self):
        a,b=socket.socketpair();c,d=socket.socketpair()
        thread=threading.Thread(target=lambda: bridge.relay(b,c,deadline=2));thread.start()
        try:
            a.sendall(b'request');self.assertEqual(d.recv(20),b'request');a.shutdown(socket.SHUT_WR)
            self.assertEqual(d.recv(20),b'');d.sendall(b'response');d.shutdown(socket.SHUT_WR)
            self.assertEqual(a.recv(20),b'response');self.assertEqual(a.recv(20),b'')
            thread.join(3);self.assertFalse(thread.is_alive())
        finally:
            for s in (a,b,c,d):s.close()
    def test_proxy_connect_and_http_use_only_approved_broker(self):
        original=bridge.connect_egress
        peers=[];calls=[]
        def connect(host,port):
            calls.append((host,port));a,b=socket.socketpair();peers.append(b);return a
        bridge.connect_egress=connect
        server=bridge.BoundedServer(('127.0.0.1',0),bridge.ProxyHandler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            with socket.create_connection(server.server_address,timeout=2) as client:
                client.sendall(b'CONNECT api.company.test:443 HTTP/1.1\r\n\r\n')
                self.assertIn(b'200 Connection Established',client.recv(1024));client.sendall(b'tls-data')
                self.assertEqual(peers[0].recv(32),b'tls-data');peers[0].sendall(b'result');self.assertEqual(client.recv(32),b'result')
            self.assertEqual(calls,[('api.company.test',443)])
        finally:
            server.shutdown();server.server_close();bridge.connect_egress=original
            for p in peers:p.close()

if __name__ == '__main__': unittest.main()
