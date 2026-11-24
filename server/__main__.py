"""Run PaperColab on this machine.

    PAPERCOLAB_DEMO=1 python3 -m server

Demo mode creates Ada, Bao, Iris and Quill and refuses to listen on a public address.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import secrets
import signal
import sys
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.http_app import Api
from server.service import DEMO_ACTORS, Service, ServiceError
from server.transport import MAX_REQUEST_BYTES, body_length, dispatch, json_response


def make_handler(api):
    class Handler(BaseHTTPRequestHandler):
        timeout = 30

        def do_GET(self):
            self.respond()

        def do_HEAD(self):
            self.respond()

        def do_POST(self):
            self.respond()

        def do_DELETE(self):
            self.respond()

        def respond(self):
            if self.headers.get("transfer-encoding"):
                self._send(400, {"error": "Send the request with a Content-Length."})
                return
            try:
                length = body_length(self.headers.get("content-length"))
            except ValueError:
                self._send(400, {"error": "Invalid Content-Length."})
                return
            if length > MAX_REQUEST_BYTES:
                self._send(413, {"error": "The upload exceeds 64 MiB."})
                return
            body = self.rfile.read(length) if length else b""
            if len(body) != length:
                self._send(400, {"error": "The request body ended early."})
                return
            headers = {key.lower(): value for key, value in self.headers.items()}
            self._write(*dispatch(api, self.command, self.path, headers, body))

        def _send(self, status, payload):
            self._write(*json_response(status, payload))

        def _write(self, status, data, headers):
            self.send_response(status)
            for name, value in headers:
                self.send_header(name, value)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(data)

        def log_message(self, fmt, *args):
            return

    return Handler


def bootstrap_operator(service, data, configured_token):
    for _, _, token, _, _ in DEMO_ACTORS:
        try:
            service.actor_by_token(token)
        except ServiceError as error:
            if error.status != 401:
                raise
        else:
            raise SystemExit("Use a separate PAPERCOLAB_DATA directory for a non-demo workspace.")
    if service.db.execute("SELECT 1 FROM actors").fetchone():
        return
    if configured_token:
        token = configured_token.strip()
        if len(token) < 32 or any(char.isspace() for char in token):
            raise SystemExit("PAPERCOLAB_OPERATOR_TOKEN must be a secret of at least 32 characters without whitespace.")
    else:
        token_path = data / "operator-token"
        if token_path.exists():
            token = token_path.read_text().strip()
        else:
            token = secrets.token_urlsafe(32)
            fd = os.open(token_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as stream:
                stream.write(token + "\n")
        print(f"Initial operator sign-in key is saved at {token_path}.", flush=True)
    service._insert_actor("Operator", "human", token, "operator")
    service.db.commit()


def stop_server(_signal_number, _frame):
    raise KeyboardInterrupt


def open_api(host):
    os.umask(0o077)
    demo = os.environ.get("PAPERCOLAB_DEMO") == "1"
    if demo and host not in {"127.0.0.1", "localhost", "::1"}:
        raise SystemExit("Refusing demo credentials on a non-local address.")
    origin = os.environ.get("PAPERCOLAB_PUBLIC_ORIGIN") or os.environ.get("RENDER_EXTERNAL_URL")
    if origin:
        url = urlsplit(origin)
        if url.scheme not in {"http", "https"} or not url.hostname or url.path not in {"", "/"} or url.query or url.fragment or url.username:
            raise SystemExit("PAPERCOLAB_PUBLIC_ORIGIN must be an HTTP or HTTPS origin without a path.")
    secure = os.environ.get("PAPERCOLAB_SECURE_COOKIES") == "1" or bool(origin and origin.startswith("https://"))
    data = Path(os.environ.get("PAPERCOLAB_DATA", ROOT / "data"))
    service = Service(data / "papercolab.sqlite", demo=demo)
    try:
        if not demo:
            bootstrap_operator(service, data, os.environ.get("PAPERCOLAB_OPERATOR_TOKEN"))
        return Api(service, secure=secure, public_origin=origin)
    except BaseException:
        service.close()
        raise


def main():
    host = os.environ.get("PAPERCOLAB_HOST", "127.0.0.1")
    port = int(os.environ.get("PAPERCOLAB_PORT") or os.environ.get("PORT", "8787"))
    api = open_api(host)
    try:
        with ThreadingHTTPServer((host, port), make_handler(api)) as server:
            signal.signal(signal.SIGTERM, stop_server)
            origin = api.access.public_origin
            print(f"PaperColab workspace at {origin or f'http://{host}:{server.server_port}'}/", flush=True)
            server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        with api.service.lock:
            api.service.close()


if __name__ == "__main__":
    main()
