"""Single-process WSGI entry point for the hosted workspace."""

from http import HTTPStatus

from server.__main__ import open_api
from server.transport import MAX_REQUEST_BYTES, body_length, dispatch, json_response


def read_response(api, environ):
    try:
        length = body_length(environ.get("CONTENT_LENGTH"))
    except ValueError:
        return json_response(400, {"error": "Invalid Content-Length."})
    chunked = bool(environ.get("HTTP_TRANSFER_ENCODING"))
    if chunked and not environ.get("wsgi.input_terminated"):
        return json_response(400, {"error": "Send the request with a Content-Length."})
    if length > MAX_REQUEST_BYTES:
        return json_response(413, {"error": "The upload exceeds 64 MiB."})
    body = environ["wsgi.input"].read(MAX_REQUEST_BYTES + 1 if chunked else length)
    if len(body) > MAX_REQUEST_BYTES:
        return json_response(413, {"error": "The upload exceeds 64 MiB."})
    if not chunked and len(body) != length:
        return json_response(400, {"error": "The request body ended early."})
    headers = {k[5:].lower().replace("_", "-"): v for k, v in environ.items() if k.startswith("HTTP_")}
    headers["content-type"] = environ.get("CONTENT_TYPE", "")
    path = environ.get("PATH_INFO", "/")
    if environ.get("QUERY_STRING"):
        path += "?" + environ["QUERY_STRING"]
    return dispatch(api, environ["REQUEST_METHOD"], path, headers, body)


def create_app():
    api = open_api("0.0.0.0")

    def application(environ, start_response):
        status, body, headers = read_response(api, environ)
        start_response(f"{status} {HTTPStatus(status).phrase}", headers)
        return [body] if environ["REQUEST_METHOD"] != "HEAD" else []

    return application
