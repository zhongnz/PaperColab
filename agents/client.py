"""Narrow task client. Never passes a PaperColab credential to a model."""
import json
import os
import re
import uuid
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler
from urllib.parse import urlsplit
from urllib.error import HTTPError, URLError

MAX_RESPONSE = 2 * 1024 * 1024


class ClientError(Exception):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


# Disable ambient proxy settings: task credentials are local, not proxy traffic.
_OPENER = build_opener(ProxyHandler({}), NoRedirect())


def request_json(url, headers, body=None, timeout=30):
    payload = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = Request(url, data=payload, headers={**headers, "Accept": "application/json",
                  **({"Content-Type": "application/json"} if payload is not None else {})})
    try:
        with _OPENER.open(req, timeout=timeout) as response:
            raw = response.read(MAX_RESPONSE + 1)
        if len(raw) > MAX_RESPONSE:
            raise ClientError("Response exceeds the local size limit.")
        data = json.loads(raw)
    except HTTPError as error:
        # Never echo a provider response, request, credential or manuscript.
        raise ClientError("HTTP request rejected (status %s)." % error.code) from None
    except (URLError, OSError, ValueError):
        raise ClientError("Request failed or returned invalid JSON.") from None
    if not isinstance(data, dict):
        raise ClientError("Expected a JSON object.")
    return data


def loopback_origin(value):
    try:
        parts = urlsplit(value)
        if (parts.scheme != "http" or parts.hostname not in {"127.0.0.1", "::1"}
                or parts.username or parts.password or parts.query or parts.fragment
                or parts.path not in {"", "/"} or parts.port is None or parts.port < 1):
            raise ValueError()
    except ValueError:
        raise ClientError("Use an explicit numeric loopback HTTP origin and port.") from None
    return value.rstrip("/")


def validate_proposal(value, context):
    if not isinstance(value, dict) or set(value) != {"after", "rationale", "evidence_ids"}:
        raise ClientError("Proposal must contain exactly after, rationale, evidence_ids.")
    after, reason, ids = value["after"], value["rationale"], value["evidence_ids"]
    if (not isinstance(after, str) or not after.strip() or after == context["cell"]["source"]
            or not isinstance(reason, str) or not reason.strip() or len(reason) > 4000
            or not isinstance(ids, list) or len(ids) > 12 or any(not isinstance(x, str) for x in ids)):
        raise ClientError("Invalid proposal content.")
    try:
        if len(after.encode("utf-8")) > 128 * 1024:
            raise ClientError("Proposal exceeds the cell limit.")
    except UnicodeError:
        raise ClientError("Invalid Unicode in proposal.") from None
    allowed = {obj["id"] for obj in context["context"]}
    if len(set(ids)) != len(ids) or not set(ids) <= allowed:
        raise ClientError("Proposal evidence must be a distinct subset of assigned context.")
    return value


class TaskClient:
    def __init__(self, origin, task_id, token, transport=request_json):
        self.origin = loopback_origin(origin)
        try:
            self.task_id = str(uuid.UUID(task_id))
        except (ValueError, TypeError, AttributeError):
            raise ClientError("Invalid task ID.") from None
        if not isinstance(token, str) or not re.fullmatch(r"pc-task-[A-Za-z0-9_-]{32,80}", token):
            raise ClientError("A restricted task credential is required, not a project token.")
        self._token = token
        self.transport = transport

    @classmethod
    def from_env(cls):
        return cls(os.environ.get("PAPERCOLAB_URL", "http://127.0.0.1:8787"),
                   os.environ.get("PAPERCOLAB_TASK_ID", ""),
                   os.environ.get("PAPERCOLAB_TASK_TOKEN", ""))

    def _request(self, suffix, data=None):
        return self.transport(self.origin + "/api/delegated/" + self.task_id + suffix,
                              {"Authorization": "Bearer " + self._token}, data)

    def context(self):
        result = self._request("/context")
        if (result.get("task_id") != self.task_id or not isinstance(result.get("cell"), dict)
                or not isinstance(result.get("context"), list) or not isinstance(result.get("instructions"), str)):
            raise ClientError("Unexpected delegated context response.")
        return result

    def submit(self, proposal):
        # Fresh context preflight; server repeats authority/version validation.
        valid = validate_proposal(proposal, self.context())
        result = self._request("/proposal", valid)
        if result.get("task_id") != self.task_id or result.get("suggestion", {}).get("status") != "pending":
            raise ClientError("Unexpected proposal response; check task status before retrying.")
        return result
