"""Browser sessions and single-use project invitations."""

from dataclasses import dataclass
from hashlib import sha256
from http.cookies import CookieError, SimpleCookie
import secrets
import uuid

from server.service import ServiceError


SESSION_COOKIE = "papercolab_session"
SESSION_AGE = 30 * 86400
INVITE_AGE = 7 * 86400
INVITE_ROLES = {"reader", "reviewer", "author"}


@dataclass
class WithHeaders:
    payload: dict
    headers: dict


def digest(secret):
    return sha256(secret.encode()).hexdigest()


class Access:
    def __init__(self, service, *, secure=False, public_origin=None):
        self.service = service
        self.secure = secure
        self.public_origin = public_origin.rstrip("/") if public_origin else None
        self.ensure_tables()

    @property
    def db(self):
        return self.service.db

    def ensure_tables(self):
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS browser_sessions (
          secret_hash TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
          expires_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS project_invitations (
          id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          created_by TEXT NOT NULL REFERENCES actors(id), expires_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS project_invitations_by_project ON project_invitations(project_id);
        CREATE INDEX IF NOT EXISTS audit_by_project ON audit(project_id, id);
        """)

    def cookie_token(self, headers):
        try:
            cookies = SimpleCookie(headers.get("cookie", ""))
        except CookieError:
            return None
        cookie = cookies.get(SESSION_COOKIE)
        return cookie.value if cookie else None

    def session_actor(self, secret):
        if not secret:
            return None
        row = self.db.execute("""SELECT a.* FROM browser_sessions AS s
            JOIN actors AS a ON a.id = s.actor_id
            WHERE s.secret_hash = ? AND s.expires_at > ? AND a.revoked = 0""",
                              (digest(secret), self.service.now())).fetchone()
        return self.service._actor(row) if row else None

    def check_origin(self, headers, *, require_origin):
        origin = headers.get("origin")
        scheme = "https" if self.secure else "http"
        expected = self.public_origin or f"{scheme}://{headers.get('host', '')}"
        if (headers.get("sec-fetch-site") == "cross-site" or
                (origin is not None and origin != expected) or (require_origin and origin is None)):
            raise ServiceError(403, "Open PaperColab on the same origin to finish this request.")

    def _cookie(self, secret, max_age):
        secure = "; Secure" if self.secure else ""
        return {"Set-Cookie": f"{SESSION_COOKIE}={secret}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure}"}

    def sign_in(self, token, existing_secret):
        if not isinstance(token, str):
            raise ServiceError(400, "Enter a sign-in key.")
        actor = self.service.actor_by_token(token.strip())
        if actor["revoked"] or actor["kind"] != "human":
            raise ServiceError(403, "A current human account is required.")
        with self.db:
            return self._new_session(actor["id"], existing_secret, {"signed_in": True})

    def _new_session(self, actor_id, existing_secret, payload):
        now = self.service.now()
        token = secrets.token_urlsafe(32)
        self.db.execute("DELETE FROM browser_sessions WHERE expires_at <= ?", (now,))
        if existing_secret:
            self.db.execute("DELETE FROM browser_sessions WHERE secret_hash = ?", (digest(existing_secret),))
        self.db.execute("INSERT INTO browser_sessions VALUES (?, ?, ?)", (digest(token), actor_id, now + SESSION_AGE))
        return WithHeaders(payload, self._cookie(token, SESSION_AGE))

    def sign_out(self, token):
        if token:
            with self.db:
                self.db.execute("DELETE FROM browser_sessions WHERE secret_hash = ?", (digest(token),))
        return WithHeaders({"signed_in": False}, self._cookie("", 0))

    def invitations(self, actor, project_id):
        self.service.require(actor, project_id, "members")
        return [dict(row) for row in self.db.execute("""SELECT id, role, expires_at FROM project_invitations
            WHERE project_id = ? AND expires_at > ? ORDER BY expires_at DESC""", (project_id, self.service.now()))]

    def invite(self, actor, project_id, role):
        self.service.require(actor, project_id, "members")
        if not isinstance(role, str) or role not in INVITE_ROLES:
            raise ServiceError(400, "Choose reader, reviewer or author access.")
        invite_id = str(uuid.uuid4())
        code = secrets.token_urlsafe(32)
        now = self.service.now()
        expiry = now + INVITE_AGE
        with self.db:
            self.db.execute("DELETE FROM project_invitations WHERE project_id = ? AND expires_at <= ?", (project_id, now))
            self.db.execute("INSERT INTO project_invitations VALUES (?, ?, ?, ?, ?, ?)",
                            (invite_id, digest(code), role, project_id, actor["id"], expiry))
            self.service._audit(actor["id"], "create-invitation", project_id, {"invitation": invite_id, "role": role})
        return {"id": invite_id, "code": code, "role": role, "expires_at": expiry}

    def cancel_invite(self, actor, project_id, invite_id):
        self.service.require(actor, project_id, "members")
        with self.db:
            removed = self.db.execute("DELETE FROM project_invitations WHERE project_id = ? AND id = ?",
                                      (project_id, invite_id)).rowcount
            if not removed:
                raise ServiceError(404, "That invitation is no longer available.")
            self.service._audit(actor["id"], "cancel-invitation", project_id, {"invitation": invite_id})
        return {"removed": invite_id}

    def redeem(self, code, name, session_secret):
        if not isinstance(code, str) or not code or len(code) > 128:
            raise ServiceError(400, "Open a valid invitation link.")
        actor = self.session_actor(session_secret)
        with self.db:
            invite = self.db.execute("""SELECT i.* FROM project_invitations AS i
                JOIN projects AS p ON p.id = i.project_id
                JOIN members AS m ON m.project_id = i.project_id AND m.actor_id = i.created_by AND m.role = 'lead'
                JOIN actors AS a ON a.id = i.created_by AND a.revoked = 0
                WHERE i.secret_hash = ? AND i.expires_at > ?""", (digest(code), self.service.now())).fetchone()
            if not invite:
                raise ServiceError(404, "This invitation has expired, was used, or was revoked.")
            payload = {"project_id": invite["project_id"]}
            if actor:
                actor_id = actor["id"]
            else:
                name = name.strip() if isinstance(name, str) else ""
                if not name or len(name) > 120:
                    raise ServiceError(400, "Enter a display name of up to 120 characters.")
                recovery_key = secrets.token_urlsafe(32)
                actor_id = self.service._insert_actor(name, "human", recovery_key, "")
                payload["recovery_key"] = recovery_key
            self.db.execute("""INSERT INTO members (project_id, actor_id, role) VALUES (?, ?, ?)
                ON CONFLICT(project_id, actor_id) DO NOTHING""", (invite["project_id"], actor_id, invite["role"]))
            self.db.execute("DELETE FROM project_invitations WHERE id = ?", (invite["id"],))
            self.service._audit(actor_id, "redeem-invitation", invite["project_id"], {"invitation": invite["id"]})
            return self._new_session(actor_id, session_secret, payload)
