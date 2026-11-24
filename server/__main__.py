"""Run PaperColab on this machine.

    PAPERCOLAB_DEMO=1 python3 -m server

Demo mode creates Ada, Bao, Iris and Quill and refuses to listen on a public address.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import sys
import time
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.http_app import Api
from server.service import Service, ServiceError


def make_handler(api):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            bits = [p for p in urlsplit(self.path).path.split("/") if p]
            if len(bits) == 4 and bits[:2] == ["api", "projects"] and bits[3] == "live":
                self.live_stream(bits[2])
            else:
                self.respond()

        def live_stream(self, project):
            auth = self.headers.get("Authorization", "")
            token = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
            # Browsers use fetch with a bearer header, never a URL credential.
            # Reject cross-origin browser requests, including DNS-rebinding hosts.
            host = self.headers.get("Host", "")
            if host.split(":")[0] not in {"127.0.0.1", "localhost"} and not host.startswith("[::1]:"):
                self._send(403, {"error": "Experimental stream is loopback-only."})
                return
            origin = self.headers.get("Origin")
            if origin and origin not in {"http://" + host, "https://" + host}:
                self._send(403, {"error": "Cross-origin stream is not permitted."})
                return
            try:
                with api.service.lock:
                    key = api.live.join(token, project)
            except ServiceError as error:
                self._send(error.status, {"error": str(error)})
                return
            try:
                self.connection.settimeout(3)
                self.send_response(200)
                self.send_header("content-type", "application/x-ndjson")
                self.send_header("cache-control", "no-store")
                self.send_header("x-content-type-options", "nosniff")
                self.send_header("connection", "close")
                self.end_headers()
                def send(event):
                    self.wfile.write((json.dumps(event, separators=(",", ":")) + "\n").encode())
                    self.wfile.flush()
                send({"type": "hello", "session": key})
                previous, last = None, 0
                deadline = time.monotonic() + api.live.SESSION_SECONDS
                while time.monotonic() < deadline:
                    try:
                        with api.service.lock:
                            state = api.live.state(key, token, project)
                    except ServiceError as error:
                        send({"type": "closed", "status": error.status})
                        break
                    now = time.monotonic()
                    if state != previous or now - last >= api.live.HEARTBEAT_SECONDS:
                        send({"type": "state", **state})
                        previous, last = state, now
                    time.sleep(0.4)
            except (OSError, TimeoutError):
                pass
            finally:
                with api.service.lock:
                    api.live.leave(key)
                self.close_connection = True

        def do_POST(self):
            self.respond()

        def do_DELETE(self):
            self.respond()

        def respond(self):
            host = self.headers.get("Host", "")
            origin = self.headers.get("Origin")
            try:
                authority = urlsplit("http://" + host)
                valid_host = (authority.hostname in {"127.0.0.1", "localhost", "::1"}
                              and not authority.username and not authority.password
                              and not authority.path and not authority.query and not authority.fragment
                              and (authority.port is None or 1 <= authority.port <= 65535))
            except ValueError:
                valid_host = False
            if not valid_host or (origin and origin != "http://" + host):
                self._send(403, {"error": "Only same-origin loopback requests are permitted."})
                return
            try:
                length = int(self.headers.get("content-length") or 0)
            except ValueError:
                self._send(400, {"error": "Invalid request length."})
                return
            if length < 0:
                self._send(400, {"error": "Invalid request length."})
                return
            if self.path.split("?")[0].startswith("/api/delegated/") and length > 512 * 1024:
                self._send(413, {"error": "Delegated request exceeds 512 KiB."})
                return
            if self.path.split("?")[0].endswith("/presence") and length > 4096:
                self._send(413, {"error": "Presence message too large."})
                return
            if self.path.split("?")[0].endswith("/compile-preview") and length > 4096:
                self._send(413, {"error": "Preview request exceeds 4 KiB."})
                return
            if length > 64 * 1024 * 1024:
                self._send(413, {"error": "The upload exceeds 64 MiB."})
                return
            body = self.rfile.read(length) if length else b""
            headers = {key.lower(): value for key, value in self.headers.items()}
            bits=[p for p in urlsplit(self.path).path.split("/") if p]
            if self.command=="POST" and len(bits)==4 and bits[:2]==["api","projects"] and bits[3]=="compile-preview":
                if length>4096:
                    self._send(413,{"error":"Preview request exceeds 4 KiB."})
                    return
                status,payload=api.preview.handle(bits[2],headers,body)
            else:
                with api.service.lock:
                    status, payload = api.handle(self.command, self.path, headers, body)
            if isinstance(payload, dict) and "file" in payload and status == 200:
                data = Path(payload["file"]).read_bytes()
                self.send_response(200)
                self.send_header("content-type", payload["type"])
                self.send_header("content-length", str(len(data)))
                self.send_header("cache-control", "no-store")
                self.send_header("x-content-type-options", "nosniff")
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
            self.send_header("x-content-type-options", "nosniff")
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, fmt, *args):
            return

    return Handler


def main():
    host = os.environ.get("PAPERCOLAB_HOST", "127.0.0.1")
    port = int(os.environ.get("PAPERCOLAB_PORT", "8787"))
    demo = os.environ.get("PAPERCOLAB_DEMO") == "1"
    if host not in {"127.0.0.1", "localhost", "::1"}:
        raise SystemExit("v0.1 is a loopback-only development preview. Public deployment is not supported.")
    data = Path(os.environ.get("PAPERCOLAB_DATA", ROOT / "data"))
    crdt = os.environ.get("PAPERCOLAB_EXPERIMENTAL_CRDT") == "1"
    if crdt and host not in {"127.0.0.1", "localhost", "::1"}:
        raise SystemExit("Experimental collaboration is loopback-only.")
    service = Service(data / "papercolab.sqlite", demo=demo, crdt=crdt)
    if service.db.execute("SELECT 1 FROM actors").fetchone() and demo != service.has_demo_accounts():
        service.close()
        raise SystemExit("Use separate PAPERCOLAB_DATA directories for demo and non-demo accounts.")
    if not demo and not service.db.execute("SELECT id FROM actors").fetchone():
        token = __import__("secrets").token_urlsafe(24)
        service._insert_actor("Operator", "human", token, "operator")
        service.db.commit()
        print("Operator token:", token)
    if demo:
        print("Demo tokens: demo-ada (lead), demo-bao (author), demo-iris (reviewer), demo-quill (assistant)")
    server = ThreadingHTTPServer((host, port), make_handler(Api(service,preview=os.environ.get("PAPERCOLAB_LOCAL_PDF_PREVIEW")=="1")))
    print(f"PaperColab workspace at http://{host}:{port}/")
    server.serve_forever()


if __name__ == "__main__":
    main()
