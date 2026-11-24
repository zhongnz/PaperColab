"""HTTP response handling shared by the local and hosted entry points."""

from http import HTTPStatus
import json
from pathlib import Path

from server.access import WithHeaders
from server.preview import PreviewJob


MAX_REQUEST_BYTES = 64 * 1024 * 1024


def body_length(value):
    if value and (not value.isascii() or not value.isdecimal()):
        raise ValueError("Invalid Content-Length.")
    return int(value or 0)


def dispatch(api, method, target, headers, body):
    path = target.partition("?")[0]
    if path.startswith("/api/") and path != "/api/health":
        with api.service.lock:
            status, payload = api.handle(method, target, headers, body)
    else:
        status, payload = api.handle(method, target, headers, body)

    if isinstance(payload, PreviewJob):
        status, payload = payload.resolve()

    response_headers = {}
    if isinstance(payload, WithHeaders):
        response_headers, payload = payload.headers, payload.payload
    if isinstance(payload, dict) and "file" in payload and status == HTTPStatus.OK:
        path = Path(payload["file"])
        data = path.read_bytes() if method != "HEAD" else b""
        size = path.stat().st_size if method == "HEAD" else len(data)
        return status, data, _headers(payload["type"], size, response_headers)
    return json_response(status, payload, response_headers)


def json_response(status, payload, headers=None):
    data = json.dumps(payload).encode("utf-8")
    return status, data, _headers("application/json", len(data), headers or {})


def _headers(content_type, size, headers):
    return [
        ("Content-Type", content_type),
        ("Content-Length", str(size)),
        ("Cache-Control", "no-store"),
        ("X-Content-Type-Options", "nosniff"),
        ("X-Frame-Options", "DENY"),
        ("Referrer-Policy", "no-referrer"),
        *headers.items(),
    ]
