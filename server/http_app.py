"""HTTP adapter. The service module decides what is allowed."""
import json
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"


class Api:
    def __init__(self, service):
        self.service = service
        from server.live import Live
        self.live = Live(service)

    def handle(self, method, target, headers, body):
        parts = urlsplit(target)
        path = parts.path
        query = {key: values[-1] for key, values in parse_qs(parts.query).items()}
        token = headers.get("authorization", "")
        if token.lower().startswith("bearer "):
            token = token[7:].strip()
        else:
            token = ""
        if path == "/api/health" and method == "GET":
            return 200, {"ok": True, "demo": self.service.demo}
        try:
            bits = [part for part in path.split("/") if part]
            # A task capability is deliberately NOT an ordinary actor token.
            # The only routes that accept it are these two exact endpoints.
            if len(bits) == 4 and bits[:2] == ["api", "delegated"]:
                if bits[3] == "context" and method == "GET":
                    return 200, self.service.delegated_context(bits[2], token)
                if bits[3] == "proposal" and method == "POST":
                    from server.service import ServiceError
                    try:
                        data = json.loads(body.decode() or "{}")
                    except (ValueError, UnicodeError):
                        raise ServiceError(400, "Invalid delegated proposal JSON.")
                    if not isinstance(data, dict) or set(data) != {"after", "rationale", "evidence_ids"}:
                        raise ServiceError(400, "Only after, rationale and evidence_ids are allowed.")
                    return 200, self.service.delegated_proposal(bits[2], token, data["after"], data["rationale"], data["evidence_ids"])
                raise self._missing()
            if path.startswith("/api/"):
                if token.startswith("pc-task-"):
                    from server.service import ServiceError
                    raise ServiceError(401, "A delegated credential is restricted to its task.")
                actor = self.service.actor_by_token(token)
                if actor["revoked"]:
                    from server.service import ServiceError
                    raise ServiceError(403, "This actor is revoked.")
                return 200, self.route(method, path, query, headers, body, actor)
            if method == "GET":
                return self.static(path)
            return 405, {"error": "Method not allowed."}
        except Exception as error:
            status = getattr(error, "status", None) or 500
            if status == 500:
                return 500, {"error": "The request failed. Contact the local operator."}
            return status, {"error": str(error)}

    def route(self, method, path, query, headers, body, actor):
        content = headers.get("content-type", "")
        try:
            data = json.loads(body.decode() or "{}") if body and "json" in content else {}
        except (ValueError, UnicodeError):
            from server.service import ServiceError
            raise ServiceError(400, "Invalid JSON request.") from None
        if not isinstance(data, dict):
            from server.service import ServiceError
            raise ServiceError(400, "Expected a JSON object.")
        bits = [part for part in path.split("/") if part]
        # /api/...
        if bits[:2] == ["api", "me"] and method == "GET":
            return {"id": actor["id"], "name": actor["name"], "kind": actor["kind"], "workspace_role": actor["workspace_role"],
                    "experimental_crdt": self.service.crdt and (ROOT / "experiments/crdt/browser.bundle.js").is_file(),
                    "experimental_live": self.service.crdt}
        if bits[:2] == ["api", "projects"] and len(bits) == 2 and method == "GET":
            return self.service.projects(actor)
        if bits[:2] == ["api", "projects"] and len(bits) == 2 and method == "POST":
            return self.service.create_project(actor, data.get("title") or "", bool(data.get("example")))
        if len(bits) == 3 and bits[:2] == ["api", "projects"] and method == "GET":
            return self.service.project(actor, bits[2])
        if len(bits) == 4 and bits[:2] == ["api", "projects"] and bits[3] == "example" and method == "POST":
            return self.service.import_example(actor, bits[2])
        if len(bits) == 4 and bits[:2] == ["api", "projects"] and bits[3] == "import" and method == "POST":
            return self.service.import_zip(actor, bits[2], body)
        if len(bits) == 4 and bits[:2] == ["api", "projects"] and bits[3] == "presence" and method == "POST":
            return self.live.update(actor, bits[2], data)
        if len(bits) == 4 and bits[:2] == ["api", "projects"] and bits[3] == "revision" and method == "GET":
            return self.service.manuscript_revision(actor, bits[2])
        if len(bits) == 6 and bits[:2] == ["api", "projects"] and bits[3] == "blocks" and bits[5] == "crdt":
            if method == "GET":
                return self.service.crdt_state(actor, bits[2], bits[4])
            if method == "POST":
                return self.service.crdt_update(actor, bits[2], bits[4], data.get("version"), data.get("epoch"), data.get("update"))
        if len(bits) == 6 and bits[:2] == ["api", "projects"] and bits[3] == "blocks" and bits[5] == "structure" and method == "POST":
            return self.service.structural_edit(actor, bits[2], bits[4], data.get("revision"), data.get("version"), data.get("action"), data.get("options"))
        if len(bits) == 6 and bits[:2] == ["api", "projects"] and bits[3] == "blocks" and bits[5] == "edit" and method == "POST":
            return self.service.direct_edit(actor, bits[2], bits[4], data.get("version"), data.get("before"), data.get("after"), data.get("mode"))
        if len(bits) == 4 and bits[:2] == ["api", "projects"] and bits[3] == "file" and method == "GET":
            return self.service.file_text(actor, bits[2], query["path"])
        if len(bits) == 4 and bits[:2] == ["api", "projects"] and bits[3] == "export" and method == "GET":
            return {"zip_b64": __import__("base64").b64encode(self.service.export_zip(actor, bits[2])).decode()}
        if len(bits) == 4 and bits[:2] == ["api", "projects"] and bits[3] == "experiments" and method == "POST":
            return self.service.create_experiment(actor, bits[2], data)
        if len(bits) == 6 and bits[:2] == ["api", "projects"] and bits[3] == "experiments":
            if bits[5] == "bundle" and method == "GET":
                return self.service.experiment_bundle(actor, bits[2], bits[4])
            if bits[5] == "receipt" and method == "POST":
                return self.service.submit_experiment(actor, bits[2], bits[4], data)
            if bits[5] == "review" and method == "POST":
                return self.service.review_experiment(actor, bits[2], bits[4], data.get("outcome"), data.get("assessment"))
            if bits[5] == "output-links" and method == "POST":
                return self.service.link_experiment_output(actor,bits[2],bits[4],data.get("output_name"),data.get("block_id"),data.get("version"))
        if len(bits) == 4 and bits[:2] == ["api", "projects"] and bits[3] == "workflows" and method == "POST":
            return self.service.create_workflow(actor, bits[2], data.get("title"), data.get("objective"))
        if len(bits) == 6 and bits[:2] == ["api", "projects"] and bits[3] == "workflows" and bits[5] == "steps" and method == "POST":
            return self.service.add_workflow_step(actor, bits[2], bits[4], data)
        if len(bits) == 8 and bits[:2] == ["api", "projects"] and bits[3] == "workflows" and bits[5] == "steps" and method == "POST":
            if bits[7] == "launch":
                return self.service.launch_workflow_step(actor, bits[2], bits[4], bits[6])
            if bits[7] == "evaluate":
                return self.service.evaluate_workflow_step(actor, bits[2], bits[4], bits[6], data.get("attempt_id"), data.get("outcome"), data.get("assessment"))
        if len(bits) == 4 and bits[:2] == ["api", "projects"] and bits[3] == "agent-tasks" and method == "POST":
            return self.service.create_agent_task(actor, bits[2], data.get("block_id"), data.get("assignee_id"),
                                                  data.get("instructions"), data.get("context_ids", []))
        if len(bits) == 6 and bits[:2] == ["api", "projects"] and bits[3] == "agent-tasks" and bits[5] == "cancel" and method == "POST":
            return self.service.cancel_agent_task(actor, bits[2], bits[4])
        if len(bits) == 4 and bits[:2] == ["api", "projects"] and bits[3] == "suggestions" and method == "POST":
            return self.service.propose(actor, bits[2], data["block_id"], data["base_revision"], data["before"], data["after"], data["mode"], data.get("evidence_ids"))
        if len(bits) == 6 and bits[3] == "suggestions" and bits[5] == "accept" and method == "POST":
            return self.service.accept(actor, bits[2], bits[4])
        if len(bits) == 6 and bits[3] == "suggestions" and bits[5] == "reject" and method == "POST":
            return self.service.reject(actor, bits[2], bits[4])
        if len(bits) == 4 and bits[3] == "anchors" and method == "POST":
            return self.service.create_anchor(actor, bits[2], data["block_id"])
        if len(bits) == 6 and bits[3] == "anchors" and bits[5] == "dismiss" and method == "POST":
            return self.service.dismiss_anchor(actor, bits[2], bits[4])
        if len(bits) == 4 and bits[3] == "comments" and method == "POST":
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
        if len(bits) == 6 and bits[3] == "blocks" and bits[5] == "move" and method == "POST":
            return self.service.move_block(actor, bits[2], bits[4], data["to_offset"])
        if len(bits) == 4 and bits[3] == "members" and method == "POST":
            return self.service.add_member(actor, bits[2], data["actor_id"], data["role"])
        if len(bits) == 5 and bits[3] == "members" and method == "DELETE":
            return self.service.remove_member(actor, bits[2], bits[4])
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
            return self.service.restore(actor, raw)
        if bits[:3] == ["api", "admin", "purge"] and method == "POST":
            return self.service.purge(actor)
        if bits == ["api", "admin", "actors"] and method == "GET":
            return self.service.list_accounts(actor)
        if len(bits) == 5 and bits[:3] == ["api", "admin", "actors"] and bits[4] == "rotate" and method == "POST":
            return self.service.rotate_actor(actor,bits[3])
        if bits[:3] == ["api", "admin", "actors"] and method == "POST" and len(bits) == 3:
            created = self.service.create_actor(actor, data.get("name") or "", data.get("kind") or "human")
            return created
        if len(bits) == 5 and bits[:3] == ["api", "admin", "actors"] and bits[4] == "revoke" and method == "POST":
            return self.service.revoke_actor(actor, bits[3])
        if bits[:2] == ["api", "mcp"] and method == "POST":
            return {"result": self.service.mcp(actor, data.get("tool") or "", data.get("arguments") or {})}
        raise self._missing()

    def _missing(self):
        from server.service import ServiceError
        return ServiceError(404, "Unknown API route.")

    def static(self, path):
        if path in {"/experimental/crdt-browser.js", "/experimental/crdt-NOTICES.txt"}:
            name = "browser.bundle.js" if path.endswith(".js") else "browser-NOTICES.txt"
            candidate = ROOT / "experiments" / "crdt" / name
            if not self.service.crdt or not candidate.is_file():
                return 404, {"error": "Experimental browser collaboration is unavailable."}
            return 200, {"file": str(candidate), "type": "text/javascript; charset=utf-8" if path.endswith(".js") else "text/plain; charset=utf-8"}
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
