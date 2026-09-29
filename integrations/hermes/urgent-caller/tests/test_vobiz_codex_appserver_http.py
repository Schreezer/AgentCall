import asyncio
import json
import pathlib
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / "scripts"))
from vobiz_codex_appserver import http_json  # noqa: E402


def json_response(handler, status, payload, *, location=None):
    body = json.dumps(payload).encode()
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    if location:
        handler.send_header("Location", location)
    handler.end_headers()
    handler.wfile.write(body)


class HttpJsonRedirectTests(unittest.TestCase):
    def setUp(self):
        self.target_requests = []
        target_requests = self.target_requests

        class TargetHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                target_requests.append(("GET", self.headers.get("Authorization")))
                json_response(self, 200, {"unexpected": True})

            def do_POST(self):
                target_requests.append(("POST", self.headers.get("Authorization")))
                json_response(self, 200, {"unexpected": True})

            def log_message(self, _format, *_args):
                pass

        self.target = ThreadingHTTPServer(("127.0.0.1", 0), TargetHandler)
        target_url = f"http://127.0.0.1:{self.target.server_port}/capture"

        class OriginHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == "/direct":
                    json_response(self, 200, {"ok": True, "method": "GET"})
                else:
                    json_response(self, 302, {"redirect": "refused"}, location=target_url)

            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                self.rfile.read(length)
                if self.path == "/direct":
                    json_response(self, 200, {"ok": True, "method": "POST"})
                else:
                    json_response(self, 302, {"redirect": "refused"}, location=target_url)

            def log_message(self, _format, *_args):
                pass

        self.origin = ThreadingHTTPServer(("127.0.0.1", 0), OriginHandler)
        self.origin_url = f"http://127.0.0.1:{self.origin.server_port}"
        self.threads = [
            threading.Thread(target=self.target.serve_forever, daemon=True),
            threading.Thread(target=self.origin.serve_forever, daemon=True),
        ]
        for thread in self.threads:
            thread.start()

    def tearDown(self):
        self.origin.shutdown()
        self.target.shutdown()
        self.origin.server_close()
        self.target.server_close()
        for thread in self.threads:
            thread.join(timeout=2)

    def test_cross_origin_redirect_never_receives_bearer_for_get_or_post(self):
        for method, body in (("GET", None), ("POST", {"event": "ended"})):
            with self.subTest(method=method):
                status, payload = asyncio.run(http_json(
                    f"{self.origin_url}/redirect",
                    method=method,
                    token="relay-bearer-secret",
                    body=body,
                ))
                self.assertEqual(status, 302)
                self.assertEqual(payload, {"redirect": "refused"})
        self.assertEqual(self.target_requests, [])

    def test_direct_get_and_post_still_succeed(self):
        status, payload = asyncio.run(http_json(
            f"{self.origin_url}/direct", token="relay-bearer-secret",
        ))
        self.assertEqual((status, payload), (200, {"ok": True, "method": "GET"}))

        status, payload = asyncio.run(http_json(
            f"{self.origin_url}/direct", method="POST", token="relay-bearer-secret", body={"ok": True},
        ))
        self.assertEqual((status, payload), (200, {"ok": True, "method": "POST"}))


if __name__ == "__main__":
    unittest.main()
