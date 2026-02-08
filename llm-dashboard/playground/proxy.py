#!/usr/bin/env python3
"""
WhichAI Playground — CORS Proxy
Forwards API requests to OpenAI, Anthropic, and Google endpoints.
Not an open relay: only allowed domains are proxied.

Usage: python3 proxy.py
Runs on http://localhost:8765
"""

import json
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.request import Request, urlopen
from urllib.error import HTTPError

ALLOWED_HOSTS = [
    "api.openai.com",
    "api.anthropic.com",
    "generativelanguage.googleapis.com",
]
PORT = 8765


class ProxyHandler(BaseHTTPRequestHandler):
    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    def do_POST(self):
        if self.path != "/proxy":
            self.send_response(404)
            self.end_headers()
            return

        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b'{"error":"Invalid JSON"}')
            return

        url = payload.get("url", "")
        headers = payload.get("headers", {})
        body = payload.get("body", "")

        # Validate target host
        from urllib.parse import urlparse
        host = urlparse(url).hostname
        if host not in ALLOWED_HOSTS:
            self.send_response(403)
            self._cors_headers()
            self.end_headers()
            self.wfile.write(json.dumps({"error": f"Host not allowed: {host}"}).encode())
            return

        req = Request(url, data=body.encode("utf-8") if isinstance(body, str) else json.dumps(body).encode("utf-8"))
        for k, v in headers.items():
            req.add_header(k, v)
        req.add_header("Accept-Encoding", "identity")

        try:
            resp = urlopen(req, timeout=120)
            resp_body = resp.read()
            self.send_response(resp.status)
            self._cors_headers()
            for key in ("Content-Type",):
                val = resp.getheader(key)
                if val:
                    self.send_header(key, val)
            self.end_headers()
            self.wfile.write(resp_body)
        except HTTPError as e:
            body_bytes = e.read()
            self.send_response(e.code)
            self._cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body_bytes)

    def log_message(self, fmt, *args):
        sys.stderr.write(f"[proxy] {fmt % args}\n")


if __name__ == "__main__":
    server = HTTPServer(("127.0.0.1", PORT), ProxyHandler)
    print(f"WhichAI CORS proxy running on http://127.0.0.1:{PORT}")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
