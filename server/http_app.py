"""HTTP adapter. The service module decides what is allowed."""
import json
import logging
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from server.access import Access
from server.preview import PreviewJob
from server.service import ServiceError

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
LOG = logging.getLogger(__name__)


class Api:
    def __init__(self, service, *, secure=False, public_origin=None):
        self.service = service
        self.access = Access(service, secure=secure, public_origin=public_origin)

    def handle(self, method, target, headers, body):
        parts = urlsplit(target)
        path = parts.path
        query = {key: values[-1] for key, values in parse_qs(parts.query).items()}
        token = headers.get("authorization", "")
        if token.lower().startswith("bearer "):
            token = token[7:].strip()
        else:
            token = ""
        try:
            if path == "/api/health" and method in {"GET", "HEAD"}:
                return 200, {"ok": True, "demo": self.service.demo}
            if path.startswith("/api/"):
                cookie = self.access.cookie_token(headers)
                if method not in {"GET", "HEAD"}:
                    self.access.check_origin(headers, require_origin=bool(cookie and not token))
                if path == "/api/session" and method == "POST":
                    return 200, self.access.sign_in(self._json(headers, body).get("token"), cookie)
                if path == "/api/session" and method == "DELETE":
                    return 200, self.access.sign_out(cookie)
                if path == "/api/invitations/redeem" and method == "POST":
                    data = self._json(headers, body)
                    return 200, self.access.redeem(data.get("code"), data.get("name"), cookie)
                actor = self.service.actor_by_token(token) if token else self.access.session_actor(cookie)
                if not actor:
                    raise ServiceError(401, "Sign in to PaperColab.")
                if actor["revoked"]:
                    raise ServiceError(403, "This account has been revoked.")
                expected_actor = headers.get("x-papercolab-actor")
                if expected_actor and expected_actor != actor["id"]:
                    raise ServiceError(409, "The signed-in account changed. Reload this workspace before continuing.")
                return 200, self.route(method, path, query, headers, body, actor)
            if method in {"GET", "HEAD"}:
                return self.static(path)
            return 405, {"error": "Method not allowed."}
        except ServiceError as error:
            self.service.db.rollback()
            return error.status, {"error": str(error)}
        except (KeyError, TypeError, ValueError):
            self.service.db.rollback()
            return 400, {"error": "The request contains missing or invalid data."}
        except Exception:
            self.service.db.rollback()
            LOG.exception("PaperColab request failed")
            return 500, {"error": "The request failed."}

    @staticmethod
    def _json(headers, body):
        if "json" not in headers.get("content-type", "") or not body:
            raise ServiceError(400, "Send a JSON object.")
        data = json.loads(body)
        if not isinstance(data, dict):
            raise ServiceError(400, "Send a JSON object.")
        return data

    def route(self, method, path, query, headers, body, actor):
        content = headers.get("content-type", "")
        data = self._json(headers, body) if body and "json" in content else {}
        bits = [part for part in path.split("/") if part]
        # /api/...
        if bits[:2] == ["api", "me"] and method == "GET":
            return {"id": actor["id"], "name": actor["name"], "kind": actor["kind"], "workspace_role": actor["workspace_role"]}
        if bits[:2] == ["api", "projects"] and len(bits) == 2 and method == "GET":
            return self.service.projects(actor)
        if bits[:2] == ["api", "projects"] and len(bits) == 2 and method == "POST":
            return self.service.create_project(actor, data.get("title") or "", bool(data.get("example")), starter=bool(data.get("starter")))
        if len(bits) == 3 and bits[:2] == ["api", "projects"] and method == "GET":
            return self.service.project(actor, bits[2])
        if len(bits) == 4 and bits[:2] == ["api", "projects"] and bits[3] == "activity" and method == "GET":
            self.service.require(actor, bits[2], "read")
            version = self.service.db.execute("SELECT max(id) FROM audit WHERE project_id = ?", (bits[2],)).fetchone()[0]
            return {"version": version}
        if len(bits) == 4 and bits[:2] == ["api", "projects"] and bits[3] == "example" and method == "POST":
            return self.service.import_example(actor, bits[2])
        if len(bits) == 4 and bits[:2] == ["api", "projects"] and bits[3] == "import" and method == "POST":
            return self.service.import_zip(actor, bits[2], body)
        if len(bits) == 4 and bits[:2] == ["api", "projects"] and bits[3] == "file" and method == "GET":
            return self.service.file_text(actor, bits[2], query["path"])
        if len(bits) == 4 and bits[:2] == ["api", "projects"] and bits[3] == "export" and method == "GET":
            return {"zip_b64": __import__("base64").b64encode(self.service.export_zip(actor, bits[2])).decode()}
        if len(bits) == 4 and bits[:2] == ["api", "projects"] and bits[3] == "preview" and method == "POST":
            engine = data.get("engine", "pdflatex")
            archive, root, revision, draft_count = self.service.preview_source(actor, bits[2], root=data.get("root"), drafts=data.get("drafts"))
            return PreviewJob(archive, root, revision, draft_count, engine)
        if len(bits) == 4 and bits[:2] == ["api", "projects"] and bits[3] == "suggestions" and method == "POST":
            return self.service.propose(actor, bits[2], data["block_id"], data["base_revision"], data["before"], data["after"],
                                        data["mode"], data.get("evidence_ids"), base_block_revision=data.get("base_block_revision"))
        if len(bits) == 6 and bits[3] == "suggestions" and bits[5] == "accept" and method == "POST":
            return self.service.accept(actor, bits[2], bits[4])
        if len(bits) == 6 and bits[3] == "suggestions" and bits[5] == "reject" and method == "POST":
            return self.service.reject(actor, bits[2], bits[4])
        if len(bits) == 4 and bits[3] == "anchors" and method == "POST":
            return self.service.create_anchor(actor, bits[2], data["block_id"])
        if len(bits) == 6 and bits[3] == "anchors" and bits[5] == "dismiss" and method == "POST":
            return self.service.dismiss_anchor(actor, bits[2], bits[4])
        if len(bits) == 4 and bits[3] == "comments" and method == "POST":
            if data.get("block_id"):
                return self.service.comment_on_block(actor, bits[2], data["block_id"], data.get("body") or "")
            return self.service.comment(actor, bits[2], data["anchor_id"], data.get("body") or "")
        if len(bits) == 6 and bits[3] == "comments" and bits[5] == "resolve" and method == "POST":
            return self.service.resolve_comment(actor, bits[2], bits[4])
        if len(bits) == 4 and bits[3] == "objects" and method == "POST":
            return self.service.add_object(actor, bits[2], data["kind"], data.get("title") or "", data.get("body") or "", data.get("external"))
        if len(bits) == 5 and bits[3] == "objects" and method == "POST":
            return self.service.update_object(actor, bits[2], bits[4], data.get("body") or "")
        if len(bits) == 4 and bits[3] == "links" and method == "POST":
            return self.service.link_claim(actor, bits[2], data["claim_id"], data["evidence_id"], data.get("anchor_id"))
        if len(bits) == 4 and bits[3] == "decisions" and method == "POST":
            return self.service.add_decision(actor, bits[2], data.get("text") or "")
        if len(bits) == 6 and bits[3] == "decisions" and method == "POST":
            return self.service.close_decision(actor, bits[2], bits[4], data.get("status") or "")
        if len(bits) == 6 and bits[3] == "blocks" and bits[5] == "owner" and method == "POST":
            return self.service.assign_owner(actor, bits[2], bits[4], data.get("owner_id"))
        if len(bits) == 4 and bits[:2] == ["api", "projects"] and bits[3] == "blocks" and method == "POST":
            return self.service.insert_cell(actor, bits[2], data["neighbor_id"], data["direction"], data["kind"],
                                            data["source"], data["base_neighbor_revision"])
        if len(bits) == 6 and bits[3] == "blocks" and bits[5] == "ai" and method == "POST":
            return self.service.set_block_ai(actor, bits[2], bits[4], data["allow_ai"])
        if len(bits) == 6 and bits[3] == "blocks" and bits[5] == "move" and method == "POST":
            return self.service.move_block(actor, bits[2], bits[4], data.get("to_offset"), neighbor_id=data.get("neighbor_id"),
                                            direction=data.get("direction"), base_block_revision=data.get("base_block_revision"),
                                            base_neighbor_revision=data.get("base_neighbor_revision"))
        if len(bits) == 4 and bits[3] == "members" and method == "POST":
            return self.service.add_member(actor, bits[2], data["actor_id"], data["role"])
        if len(bits) == 5 and bits[3] == "members" and method == "DELETE":
            return self.service.remove_member(actor, bits[2], bits[4])
        if len(bits) == 4 and bits[:2] == ["api", "projects"] and bits[3] == "invitations":
            if method == "GET":
                return self.access.invitations(actor, bits[2])
            if method == "POST":
                return self.access.invite(actor, bits[2], data.get("role"))
        if len(bits) == 5 and bits[:2] == ["api", "projects"] and bits[3] == "invitations" and method == "DELETE":
            return self.access.cancel_invite(actor, bits[2], bits[4])
        if len(bits) == 4 and bits[3] == "release" and method == "POST":
            return self.service.release(actor, bits[2])
        if len(bits) == 5 and bits[3] == "releases" and method == "GET":
            blob, manifest = self.service.release_zip(actor, bits[2], bits[4])
            return {"manifest": manifest, "zip_b64": __import__("base64").b64encode(blob).decode()}
        if bits[:2] == ["api", "search"] and method == "GET":
            return self.service.search(actor, query.get("q") or "")
        if bits[:2] == ["api", "collections"] and method == "POST":
            return self.service.create_collection(actor, data.get("name") or "", data.get("projects") or [])
        if bits[:2] == ["api", "audit"] and method == "GET":
            return self.service.audit(actor, query.get("project"))
        if bits[:3] == ["api", "admin", "policy"] and method == "POST":
            return self.service.set_policy(actor, data.get("allow_ai", True), int(data.get("retention_days") or 0))
        if bits[:3] == ["api", "admin", "policy"] and method == "GET":
            self.service.require(actor, None, "policy")
            return self.service.policy()
        if bits[:3] == ["api", "admin", "cost"] and method == "GET":
            return self.service.cost(actor)
        if bits[:3] == ["api", "admin", "backup"] and method == "GET":
            return {"zip_b64": __import__("base64").b64encode(self.service.backup(actor)).decode()}
        if bits[:3] == ["api", "admin", "restore"] and method == "POST":
            raw = body if headers.get("content-type") == "application/octet-stream" else __import__("base64").b64decode(data.get("backup_b64") or "")
            result = self.service.restore(actor, raw)
            self.access.ensure_tables()
            return result
        if bits[:3] == ["api", "admin", "purge"] and method == "POST":
            return self.service.purge(actor)
        if bits[:3] == ["api", "admin", "actors"] and method == "POST" and len(bits) == 3:
            created = self.service.create_actor(actor, data.get("name") or "", data.get("kind") or "human")
            return created
        if len(bits) == 5 and bits[:3] == ["api", "admin", "actors"] and bits[4] == "revoke" and method == "POST":
            return self.service.revoke_actor(actor, bits[3])
        if bits[:2] == ["api", "mcp"] and method == "POST":
            return {"result": self.service.mcp(actor, data.get("tool") or "", data.get("arguments") or {})}
        raise self._missing()

    def _missing(self):
        return ServiceError(404, "Unknown API route.")

    def static(self, path):
        relative = "project.html" if path in {"/", ""} else path.lstrip("/")
        candidate = (WEB / relative).resolve()
        if WEB.resolve() not in candidate.parents and candidate != WEB.resolve():
            return 404, {"error": "Not found."}
        if not candidate.is_file():
            return 404, {"error": "Not found."}
        return 200, {"file": str(candidate), "type": content_type(candidate)}


def content_type(path):
    return {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json",
        ".svg": "image/svg+xml",
        ".wasm": "application/wasm",
    }.get(path.suffix, "application/octet-stream")
