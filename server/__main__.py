"""Run PaperColab on this machine.

    PAPERCOLAB_DEMO=1 python3 -m server

Demo mode creates Ada, Bao, Iris and Quill and refuses to listen on a public address.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.http_app import Api
from server.service import Service


def make_handler(api):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.respond()

        def do_POST(self):
            self.respond()

        def do_DELETE(self):
            self.respond()

        def respond(self):
            length = int(self.headers.get("content-length") or 0)
            if length > 64 * 1024 * 1024:
                self._send(413, {"error": "The upload exceeds 64 MiB."})
                return
            body = self.rfile.read(length) if length else b""
            headers = {key.lower(): value for key, value in self.headers.items()}
            with api.service.lock:
                status, payload = api.handle(self.command, self.path, headers, body)
            if isinstance(payload, dict) and "file" in payload and status == 200:
                data = Path(payload["file"]).read_bytes()
                self.send_response(200)
                self.send_header("content-type", payload["type"])
                self.send_header("content-length", str(len(data)))
                self.send_header("cache-control", "no-store")
                self.end_headers()
                self.wfile.write(data)
                return
            self._send(status, payload)

        def _send(self, status, payload):
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.send_header("cache-control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, fmt, *args):
            return

    return Handler


def main():
    host = os.environ.get("PAPERCOLAB_HOST", "127.0.0.1")
    port = int(os.environ.get("PAPERCOLAB_PORT", "8787"))
    demo = os.environ.get("PAPERCOLAB_DEMO") == "1"
    if demo and host not in {"127.0.0.1", "localhost", "::1"}:
        raise SystemExit("Refusing demo credentials on a non-local address.")
    data = Path(os.environ.get("PAPERCOLAB_DATA", ROOT / "data"))
    service = Service(data / "papercolab.sqlite", demo=demo)
    if not demo and not service.db.execute("SELECT id FROM actors").fetchone():
        token = __import__("secrets").token_urlsafe(24)
        service._insert_actor("Operator", "human", token, "operator")
        service.db.commit()
        print("Operator token:", token)
    if demo:
        print("Demo tokens: demo-ada (lead), demo-bao (author), demo-iris (reviewer), demo-quill (assistant)")
    server = ThreadingHTTPServer((host, port), make_handler(Api(service)))
    print(f"PaperColab workspace at http://{host}:{port}/")
    server.serve_forever()


if __name__ == "__main__":
    main()
