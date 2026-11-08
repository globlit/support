import importlib.util
import pathlib
import socket
import threading
import unittest
ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('bridge', ROOT/'deployment/managed/guest-bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

class BridgeTests(unittest.TestCase):
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
