"""Experimental live revision/presence stream, with no manuscript mutation.

All registry access and permission checks run under service.lock. The HTTP
handler releases that lock before writing or waiting on a socket.
"""
import secrets
import time
from server.service import ServiceError


class Live:
    MAX_SESSIONS = 24
    SESSION_SECONDS = 60
    HEARTBEAT_SECONDS = 5

    def __init__(self, service):
        self.service = service
        self.sessions = {}

    def allowed(self, token, project):
        if not self.service.crdt:
            raise ServiceError(404, "Experimental collaboration is disabled.")
        actor = self.service.actor_by_token(token)
        self.service.require(actor, project, "read")
        return actor

    def prune(self):
        now = time.monotonic()
        for key, row in list(self.sessions.items()):
            if row["expires"] <= now:
                self.sessions.pop(key, None)
                continue
            try:
                self.allowed(row["token"], row["project"])
            except ServiceError:
                self.sessions.pop(key, None)

    def join(self, token, project):
        actor = self.allowed(token, project)
        self.prune()
        if len(self.sessions) >= self.MAX_SESSIONS:
            raise ServiceError(429, "Experimental stream capacity reached.")
        key = secrets.token_urlsafe(24)
        self.sessions[key] = {
            "token": token, "actor": actor["id"], "project": project,
            "expires": time.monotonic() + self.SESSION_SECONDS,
            "cell": None, "editing": False,
        }
        return key

    def update(self, actor, project, data):
        self.service.require(actor, project, "read")
        if not self.service.crdt:
            raise ServiceError(404, "Experimental collaboration is disabled.")
        self.prune()
        key = data.get("session")
        row = self.sessions.get(key) if isinstance(key, str) else None
        if not row or row["project"] != project or row["actor"] != actor["id"]:
            raise ServiceError(404, "Unknown presence session.")
        cell = data.get("cell")
        editing = data.get("editing")
        if type(editing) is not bool or (cell is not None and not isinstance(cell, str)):
            raise ServiceError(400, "Invalid presence state.")
        if cell is not None:
            self.service._block_row(project, cell)
        row["cell"] = cell
        row["editing"] = editing and cell is not None
        return {"ok": True}

    def state(self, key, token, project):
        actor = self.allowed(token, project)
        self.prune()
        own = self.sessions.get(key)
        if not own or own["actor"] != actor["id"] or own["project"] != project:
            raise ServiceError(409, "Presence session expired.")
        members = {r["id"]: r for r in self.service.project(actor, project)["members"]}
        presence = []
        for sid, row in self.sessions.items():
            if row["project"] != project or sid == key:
                continue
            member = members.get(row["actor"])
            if member:
                presence.append({"name": member["name"], "kind": member["kind"],
                                 "cell": row["cell"], "editing": row["editing"]})
        presence.sort(key=lambda r: (r["name"], r["cell"] or "", r["editing"]))
        return {**self.service.manuscript_revision(actor, project), "presence": presence}

    def leave(self, key):
        self.sessions.pop(key, None)
