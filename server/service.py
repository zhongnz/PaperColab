"""Self-hosted PaperColab project service.

The server is the authority for membership, suggestions, anchors, evidence and
releases. Visual and source proposals share review records. Human authors may
also submit explicitly version-checked direct cell edits.
"""
import json
import base64
import binascii
import os
from pathlib import Path
import re
import secrets
import shutil
import sqlite3
import subprocess
import tempfile
from threading import Lock
import time
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[1]
NODE = ROOT / "server" / "blocks.cjs"
EXAMPLE = ROOT / "examples" / "estuary"
DEMO_ACTORS = (
    ("Ada", "human", "demo-ada", "operator", "lead"),
    ("Bao", "human", "demo-bao", "", "author"),
    ("Iris", "human", "demo-iris", "", "reviewer"),
    ("Quill", "assistant", "demo-quill", "", "author"),
)
TEXT_SUFFIXES = {".tex", ".ltx", ".cls", ".sty", ".bib", ".json", ".md", ".txt", ".csv"}


class ServiceError(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


class Service:
    def __init__(self, database, demo=False, clock=None, crdt=False):
        self.crdt = crdt
        self.demo = demo
        self.clock = clock or time.time
        self.path = Path(database)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = Lock()
        self.db = sqlite3.connect(self.path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys = ON")
        self._schema()
        if demo and not self._rows("SELECT id FROM actors"):
            self._seed_demo()

    def close(self):
        self.db.close()

    def now(self):
        return int(self.clock())

    def _schema(self):
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS actors (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
          workspace_role TEXT NOT NULL DEFAULT '', revoked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS members (
          project_id TEXT NOT NULL, actor_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (project_id, actor_id));
        CREATE TABLE IF NOT EXISTS files (
          project_id TEXT NOT NULL, path TEXT NOT NULL, original BLOB NOT NULL, current TEXT, is_text INTEGER NOT NULL,
          is_root INTEGER NOT NULL, dirty INTEGER NOT NULL, PRIMARY KEY (project_id, path));
        CREATE TABLE IF NOT EXISTS blocks (
          project_id TEXT NOT NULL, stable_id TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL,
          start INTEGER NOT NULL, end INTEGER NOT NULL, quote TEXT NOT NULL, label TEXT NOT NULL,
          rich INTEGER NOT NULL, fallback TEXT NOT NULL, commands TEXT NOT NULL, owner_id TEXT,
          PRIMARY KEY (project_id, stable_id));
        CREATE TABLE IF NOT EXISTS crdt_cells (
          project_id TEXT NOT NULL, block_id TEXT NOT NULL, version INTEGER NOT NULL,
          epoch TEXT NOT NULL, quote TEXT NOT NULL, snapshot TEXT NOT NULL, vector TEXT NOT NULL,
          PRIMARY KEY (project_id, block_id));
        CREATE TABLE IF NOT EXISTS suggestions (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL, block_id TEXT NOT NULL, actor_id TEXT NOT NULL,
          mode TEXT NOT NULL, base_revision INTEGER NOT NULL, before_quote TEXT NOT NULL, after_quote TEXT NOT NULL,
          status TEXT NOT NULL, result TEXT NOT NULL, evidence TEXT NOT NULL, decided_by TEXT, decided_at INTEGER);
        CREATE TABLE IF NOT EXISTS anchors (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL, block_id TEXT NOT NULL, quote TEXT NOT NULL,
          actor_id TEXT NOT NULL, created_revision INTEGER NOT NULL, dismissed INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS comments (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL, anchor_id TEXT NOT NULL, actor_id TEXT NOT NULL,
          body TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS objects (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
          body TEXT NOT NULL, owner_id TEXT, external TEXT NOT NULL, revision INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS object_versions (
          object_id TEXT NOT NULL, revision INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
          external TEXT NOT NULL, PRIMARY KEY (object_id, revision));
        CREATE TABLE IF NOT EXISTS links (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL, claim_id TEXT NOT NULL, evidence_id TEXT NOT NULL,
          evidence_revision INTEGER NOT NULL, anchor_id TEXT);
        CREATE TABLE IF NOT EXISTS releases (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL, revision INTEGER NOT NULL, actor_id TEXT NOT NULL,
          manifest TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS release_files (
          release_id TEXT NOT NULL, path TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (release_id, path));
        CREATE TABLE IF NOT EXISTS decisions (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL,
          actor_id TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS collections (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, actor_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS collection_projects (
          collection_id TEXT NOT NULL, project_id TEXT NOT NULL, PRIMARY KEY (collection_id, project_id));
        CREATE TABLE IF NOT EXISTS audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor_id TEXT NOT NULL,
          action TEXT NOT NULL, project_id TEXT, detail TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS policy (
          id INTEGER PRIMARY KEY CHECK (id = 1), allow_ai INTEGER NOT NULL, retention_days INTEGER NOT NULL);
        """)
        if "version" not in {row["name"] for row in self._rows("PRAGMA table_info(blocks)")}:
            self.db.execute("ALTER TABLE blocks ADD COLUMN version INTEGER NOT NULL DEFAULT 1")
            self.db.commit()
        if not self._rows("SELECT id FROM policy"):
            self.db.execute("INSERT INTO policy (id, allow_ai, retention_days) VALUES (1, 1, 0)")
            self.db.commit()

    def _seed_demo(self):
        created = {}
        for name, kind, token, workspace_role, _role in DEMO_ACTORS:
            created[name] = self._insert_actor(name, kind, token, workspace_role)
        project = self._create_project_row("Estuary field notes")
        for name, _kind, _token, _workspace_role, role in DEMO_ACTORS:
            self.db.execute("INSERT INTO members (project_id, actor_id, role) VALUES (?, ?, ?)",
                            (project, created[name], role))
        self._audit(created["Ada"], "seed-demo", project, {"project": project})
        self.db.commit()
        ada = self.actor_by_token("demo-ada")
        self.import_example(ada, project)

    def _insert_actor(self, name, kind, token, workspace_role):
        actor_id = str(uuid.uuid4())
        self.db.execute(
            "INSERT INTO actors (id, name, kind, token, workspace_role, revoked, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
            (actor_id, name, kind, token, workspace_role, self.now()))
        return actor_id

    def _create_project_row(self, title):
        project_id = str(uuid.uuid4())
        now = self.now()
        self.db.execute("INSERT INTO projects (id, title, revision, created_at, updated_at) VALUES (?, ?, 1, ?, ?)",
                        (project_id, title, now, now))
        return project_id

    def actor_by_token(self, token):
        if not token:
            raise ServiceError(401, "Sign in with a bearer token.")
        row = self.db.execute("SELECT * FROM actors WHERE token = ?", (token,)).fetchone()
        if not row:
            raise ServiceError(401, "Unknown token.")
        return self._actor(row)

    def _actor(self, row):
        return {"id": row["id"], "name": row["name"], "kind": row["kind"], "workspace_role": row["workspace_role"],
                "revoked": bool(row["revoked"])}

    def _rows(self, sql, args=()):
        return self.db.execute(sql, args).fetchall()

    def _audit(self, actor_id, action, project_id, detail):
        self.db.execute("INSERT INTO audit (at, actor_id, action, project_id, detail) VALUES (?, ?, ?, ?, ?)",
                        (self.now(), actor_id, action, project_id, json.dumps(detail, sort_keys=True)))

    def _touch(self, project_id, revision=None):
        if revision is None:
            current = self.db.execute("SELECT revision FROM projects WHERE id = ?", (project_id,)).fetchone()
            revision = current["revision"] + 1
        self.db.execute("UPDATE projects SET revision = ?, updated_at = ? WHERE id = ?", (revision, self.now(), project_id))
        return revision

    def _member(self, actor, project_id):
        return self.db.execute("SELECT role FROM members WHERE project_id = ? AND actor_id = ?",
                               (project_id, actor["id"])).fetchone()

    def require(self, actor, project_id, action):
        if actor["revoked"]:
            raise ServiceError(403, "This actor is revoked.")
        operator_actions = {"backup", "restore", "policy", "cost", "create_actor", "revoke", "purge"}
        if action in operator_actions:
            if actor["workspace_role"] != "operator":
                raise ServiceError(403, "An operator has to do that.")
            return None
        membership = self._member(actor, project_id)
        if not membership:
            raise ServiceError(403, "You are not a member of this project.")
        role = membership["role"]
        if actor["kind"] == "assistant" and action in {"decide", "release", "members", "own", "dismiss", "direct"}:
            raise ServiceError(403, "An assistant cannot decide, release, or change authority.")
        if action == "propose" and actor["kind"] == "assistant" and not self.policy()["allow_ai"]:
            raise ServiceError(403, "AI proposals are turned off for this workspace.")
        allowed = {
            "read": {"reader", "reviewer", "author", "lead"},
            "propose": {"author", "lead"},
            "direct": {"author", "lead"},
            "comment": {"reviewer", "author", "lead"},
            "decide": {"reviewer", "lead"},
            "release": {"lead"},
            "members": {"lead"},
            "own": {"lead"},
            "dismiss": {"reviewer", "lead"},
            "decide_record": {"lead"},
        }
        if role not in allowed[action]:
            raise ServiceError(403, "Your role cannot do that.")
        return role

    def policy(self):
        row = self.db.execute("SELECT allow_ai, retention_days FROM policy WHERE id = 1").fetchone()
        return {"allow_ai": bool(row["allow_ai"]), "retention_days": row["retention_days"]}

    def set_policy(self, actor, allow_ai, retention_days):
        self.require(actor, None, "policy")
        if retention_days < 0 or retention_days > 3650:
            raise ServiceError(400, "Retention must be between 0 and 3650 days.")
        self.db.execute("UPDATE policy SET allow_ai = ?, retention_days = ? WHERE id = 1", (int(bool(allow_ai)), int(retention_days)))
        self._audit(actor["id"], "policy", None, self.policy())
        self.db.commit()
        return self.policy()

    def create_actor(self, actor, name, kind):
        self.require(actor, None, "create_actor")
        if kind not in {"human", "assistant"}:
            raise ServiceError(400, "Kind must be human or assistant.")
        token = secrets.token_urlsafe(24)
        actor_id = self._insert_actor(name.strip() or "Member", kind, token, "")
        self._audit(actor["id"], "create-actor", None, {"actor": actor_id, "kind": kind})
        self.db.commit()
        return {"id": actor_id, "name": name, "kind": kind, "token": token}

    def revoke_actor(self, actor, actor_id):
        self.require(actor, None, "revoke")
        target = self.db.execute("SELECT * FROM actors WHERE id = ?", (actor_id,)).fetchone()
        if not target:
            raise ServiceError(404, "Unknown actor.")
        self.db.execute("UPDATE actors SET revoked = 1 WHERE id = ?", (actor_id,))
        self.db.execute("UPDATE suggestions SET status = 'revoked', result = 'revoked' WHERE actor_id = ? AND status = 'pending'", (actor_id,))
        self._audit(actor["id"], "revoke", None, {"actor": actor_id})
        self.db.commit()
        return {"id": actor_id, "revoked": True}

    def create_project(self, actor, title, example=False):
        if actor["revoked"]:
            raise ServiceError(403, "This actor is revoked.")
        if actor["kind"] == "assistant":
            raise ServiceError(403, "An assistant cannot create a project.")
        project_id = self._create_project_row(title.strip() or "Untitled project")
        role = "lead"
        self.db.execute("INSERT INTO members (project_id, actor_id, role) VALUES (?, ?, ?)", (project_id, actor["id"], role))
        self._audit(actor["id"], "create-project", project_id, {"title": title})
        self.db.commit()
        if example:
            self.import_example(actor, project_id)
        return self.project(actor, project_id)

    def add_member(self, actor, project_id, actor_id, role):
        self.require(actor, project_id, "members")
        if role not in {"reader", "reviewer", "author", "lead"}:
            raise ServiceError(400, "Unknown project role.")
        target = self.db.execute("SELECT id, revoked FROM actors WHERE id = ?", (actor_id,)).fetchone()
        if not target or target["revoked"]:
            raise ServiceError(404, "Unknown actor.")
        self.db.execute("INSERT INTO members (project_id, actor_id, role) VALUES (?, ?, ?) ON CONFLICT(project_id, actor_id) DO UPDATE SET role = excluded.role",
                        (project_id, actor_id, role))
        self._audit(actor["id"], "member", project_id, {"actor": actor_id, "role": role})
        self.db.commit()
        return {"actor_id": actor_id, "role": role}

    def remove_member(self, actor, project_id, actor_id):
        self.require(actor, project_id, "members")
        self.db.execute("DELETE FROM members WHERE project_id = ? AND actor_id = ?", (project_id, actor_id))
        self._audit(actor["id"], "remove-member", project_id, {"actor": actor_id})
        self.db.commit()
        return {"removed": actor_id}

    def projects(self, actor):
        if actor["revoked"]:
            raise ServiceError(403, "This actor is revoked.")
        rows = self._rows("""SELECT p.id, p.title, p.revision, m.role FROM projects p
                             JOIN members m ON m.project_id = p.id WHERE m.actor_id = ? ORDER BY p.updated_at DESC""", (actor["id"],))
        return [dict(row) for row in rows]

    def project(self, actor, project_id):
        self.require(actor, project_id, "read")
        row = self.db.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        if not row:
            raise ServiceError(404, "Unknown project.")
        members = [dict(item) for item in self._rows("""SELECT a.id, a.name, a.kind, m.role FROM members m
                                                        JOIN actors a ON a.id = m.actor_id WHERE m.project_id = ? ORDER BY a.name""", (project_id,))]
        blocks = self._blocks(project_id)
        suggestions = self._suggestions(project_id)
        anchors = [self._anchor_view(project_id, item) for item in self._rows("SELECT * FROM anchors WHERE project_id = ?", (project_id,))]
        comments = [dict(item) for item in self._rows("SELECT * FROM comments WHERE project_id = ? ORDER BY created_at", (project_id,))]
        objects = [self._object_view(item) for item in self._rows("SELECT * FROM objects WHERE project_id = ? ORDER BY title", (project_id,))]
        links = [self._link_view(item) for item in self._rows("SELECT * FROM links WHERE project_id = ?", (project_id,))]
        decisions = [dict(item) for item in self._rows("SELECT * FROM decisions WHERE project_id = ? ORDER BY created_at", (project_id,))]
        releases = [dict(item) for item in self._rows("SELECT id, revision, actor_id, created_at FROM releases WHERE project_id = ? ORDER BY created_at", (project_id,))]
        pending = [item for item in suggestions if item["status"] == "pending"]
        unresolved = [item for item in anchors if item["status"] == "unresolved" and not item["dismissed"]]
        open_decisions = [item for item in decisions if item["status"] == "open"]
        return {
            "id": row["id"], "title": row["title"], "revision": row["revision"],
            "members": members, "blocks": blocks, "suggestions": suggestions, "anchors": anchors,
            "comments": comments, "objects": objects, "links": links, "decisions": decisions, "releases": releases,
            "readiness": {"pending_suggestions": len(pending), "unresolved_anchors": len(unresolved),
                          "open_decisions": len(open_decisions),
                          "ready": not pending and not unresolved and not open_decisions},
            "files": [dict(item) for item in self._rows("SELECT path, is_text, is_root, dirty, length(original) AS bytes FROM files WHERE project_id = ? ORDER BY path", (project_id,))],
        }

    def file_text(self, actor, project_id, path):
        self.require(actor, project_id, "read")
        row = self.db.execute("SELECT current, is_text FROM files WHERE project_id = ? AND path = ?", (project_id, path)).fetchone()
        if not row or not row["is_text"]:
            raise ServiceError(404, "That file is not editable text.")
        return {"path": path, "text": row["current"], "blocks": self._blocks(project_id, path),
                "revision": self.manuscript_revision(actor, project_id)["revision"]}

    def import_example(self, actor, project_id):
        self.require(actor, project_id, "propose")
        files = []
        for path in sorted(EXAMPLE.rglob("*")):
            if path.is_file():
                files.append(("estuary/" + path.relative_to(EXAMPLE).as_posix(), path.read_bytes()))
        return self.import_files(actor, project_id, files)

    def import_zip(self, actor, project_id, blob):
        self.require(actor, project_id, "propose")
        import sys
        sys.path.insert(0, str(ROOT / "scripts"))
        from build_worker import unpack
        with tempfile.TemporaryDirectory() as tmp:
            unpack(blob, Path(tmp))
            files = []
            for path in sorted(Path(tmp).rglob("*")):
                if path.is_file():
                    files.append((path.relative_to(tmp).as_posix(), path.read_bytes()))
        return self.import_files(actor, project_id, files)

    def import_files(self, actor, project_id, files):
        self.require(actor, project_id, "propose")
        if not files:
            raise ServiceError(400, "The import is empty.")
        if len(files) > 4000:
            raise ServiceError(400, "The import has more than 4,000 files.")
        self.db.execute("DELETE FROM crdt_cells WHERE project_id = ?", (project_id,))
        self.db.execute("DELETE FROM blocks WHERE project_id = ?", (project_id,))
        self.db.execute("DELETE FROM files WHERE project_id = ?", (project_id,))
        self.db.execute("""DELETE FROM object_versions WHERE object_id IN
                           (SELECT id FROM objects WHERE project_id = ? AND kind = 'source' AND external LIKE '%"system": "bibtex"%')""", (project_id,))
        self.db.execute("DELETE FROM objects WHERE project_id = ? AND kind = 'source' AND external LIKE '%\"system\": \"bibtex\"%'", (project_id,))
        for path, data in files:
            self._store_file(actor, project_id, path, data)
        self._touch(project_id)
        self._audit(actor["id"], "import", project_id, {"files": len(files)})
        self.db.commit()
        return self.project(actor, project_id)

    def _store_file(self, actor, project_id, path, data):
        suffix = Path(path).suffix.lower()
        text = None
        if suffix in TEXT_SUFFIXES or suffix == "":
            try:
                text = data.decode("utf-8")
            except UnicodeDecodeError:
                text = None
        is_text = text is not None
        is_root = bool(is_text and ("\\documentclass" in text or "\\begin{document}" in text))
        self.db.execute("""INSERT INTO files (project_id, path, original, current, is_text, is_root, dirty)
                           VALUES (?, ?, ?, ?, ?, ?, 0)""", (project_id, path, data, text, int(is_text), int(is_root)))
        if is_text and suffix in {".tex", ".ltx"}:
            listed = self._node({"op": "catalogue", "text": text, "root": is_root, "previous": []})
            self._replace_blocks(project_id, path, listed["blocks"])
        if is_text and suffix == ".bib":
            for entry in bib_entries(text):
                self._add_object(actor, project_id, "source", entry["title"], entry["raw"], actor["id"],
                                 {"system": "bibtex", "identifier": entry["key"], "version": "1", "access": "project", "holding": "copy"})

    def _node(self, payload):
        proc = subprocess.run(["node", str(NODE)], input=json.dumps(payload), text=True, capture_output=True, check=False, cwd=ROOT)
        if proc.returncode:
            raise ServiceError(500, "The manuscript parser failed. " + proc.stderr[-400:])
        return json.loads(proc.stdout)

    def _replace_blocks(self, project_id, path, blocks):
        prior = {row["stable_id"]: row for row in self._rows(
            "SELECT * FROM blocks WHERE project_id = ? AND path = ?", (project_id, path))}
        self.db.execute("DELETE FROM blocks WHERE project_id = ? AND path = ?", (project_id, path))
        for block in blocks:
            old = prior.get(block["stableId"])
            version = 1 if old is None else old["version"] + int(
                old["quote"] != block["quote"] or old["kind"] != block["kind"])
            self.db.execute("""INSERT INTO blocks (project_id, stable_id, path, kind, start, end, quote, label, rich, fallback, commands, owner_id, version)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                            (project_id, block["stableId"], path, block["kind"], block["from"], block["to"], block["quote"],
                             block.get("label") or "", int(block.get("rich") or 0), block.get("fallback") or "",
                             json.dumps(block.get("commands") or []), old["owner_id"] if old else None, version))

    def _blocks(self, project_id, path=None):
        sql = "SELECT * FROM blocks WHERE project_id = ?"
        args = [project_id]
        if path:
            sql += " AND path = ?"
            args.append(path)
        sql += " ORDER BY path, start"
        result = []
        for row in self._rows(sql, args):
            result.append({"stableId": row["stable_id"], "path": row["path"], "kind": row["kind"], "from": row["start"],
                           "to": row["end"], "quote": row["quote"], "label": row["label"], "rich": bool(row["rich"]),
                           "fallback": row["fallback"], "commands": json.loads(row["commands"]), "owner_id": row["owner_id"], "version": row["version"]})
        return result

    def _block_row(self, project_id, stable_id):
        row = self.db.execute("SELECT * FROM blocks WHERE project_id = ? AND stable_id = ?", (project_id, stable_id)).fetchone()
        if not row:
            raise ServiceError(404, "Unknown block.")
        return row

    def assign_owner(self, actor, project_id, stable_id, owner_id):
        self.require(actor, project_id, "own")
        self._block_row(project_id, stable_id)
        if owner_id and not self.db.execute("SELECT 1 FROM members WHERE project_id = ? AND actor_id = ?", (project_id, owner_id)).fetchone():
            raise ServiceError(400, "The owner must be a project member. Ownership does not grant a role.")
        self.db.execute("UPDATE blocks SET owner_id = ? WHERE project_id = ? AND stable_id = ?", (owner_id, project_id, stable_id))
        self._audit(actor["id"], "owner", project_id, {"block": stable_id, "owner": owner_id})
        self.db.commit()
        return {"stableId": stable_id, "owner_id": owner_id}

    def manuscript_revision(self, actor, project_id):
        self.require(actor, project_id, "read")
        row = self.db.execute("SELECT revision FROM projects WHERE id = ?", (project_id,)).fetchone()
        if not row:
            raise ServiceError(404, "Unknown project.")
        return {"revision": row["revision"]}

    def _crdt_author(self, actor, project_id):
        if not self.crdt:
            raise ServiceError(404, "Experimental collaboration is disabled.")
        self.require(actor, project_id, "direct")

    def _crdt_worker(self, payload):
        # A bounded, short-lived worker. This is NOT an OS sandbox.
        try:
            proc = subprocess.run(["node", "--max-old-space-size=128",
                                   str(ROOT / "experiments" / "crdt" / "transport.mjs")],
                                  input=json.dumps(payload), text=True, capture_output=True,
                                  cwd=ROOT, timeout=5)
            result = json.loads(proc.stdout)
        except (OSError, subprocess.TimeoutExpired, ValueError):
            raise ServiceError(503, "Experimental collaboration worker unavailable.")
        if proc.returncode or not result.get("ok"):
            raise ServiceError(400, "Invalid or unsupported collaboration update.")
        return result

    def crdt_state(self, actor, project_id, stable_id):
        self._crdt_author(actor, project_id)
        block = self._block_row(project_id, stable_id)
        if not block["rich"]:
            raise ServiceError(400, "Experimental collaboration supports editable prose and headings only.")
        if len(block["quote"].encode("utf-8")) > 128 * 1024:
            raise ServiceError(400, "Cell exceeds the experimental collaboration limit.")
        row = self.db.execute("SELECT * FROM crdt_cells WHERE project_id = ? AND block_id = ?",
                              (project_id, stable_id)).fetchone()
        if not row or row["version"] != block["version"] or row["quote"] != block["quote"]:
            result = self._crdt_worker({"op": "seed", "text": block["quote"]})
            with self.db:
                self.db.execute("""INSERT OR REPLACE INTO crdt_cells
                                   (project_id, block_id, version, epoch, quote, snapshot, vector)
                                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                                (project_id, stable_id, block["version"], str(uuid.uuid4()), block["quote"],
                                 result["snapshot"], result["vector"]))
            row = self.db.execute("SELECT * FROM crdt_cells WHERE project_id = ? AND block_id = ?",
                                  (project_id, stable_id)).fetchone()
        return {"block_id": stable_id, "version": row["version"], "epoch": row["epoch"],
                "quote": row["quote"], "snapshot": row["snapshot"], "vector": row["vector"]}

    def crdt_update(self, actor, project_id, stable_id, version, epoch, update):
        self._crdt_author(actor, project_id)
        if type(version) is not int or not isinstance(epoch, str) or not isinstance(update, str) or len(update) > 350000:
            raise ServiceError(400, "Provide a version, epoch and bounded base64 update.")
        try:
            raw = base64.b64decode(update, validate=True)
        except (ValueError, binascii.Error):
            raise ServiceError(400, "Invalid base64 update.")
        if not raw or len(raw) > 256 * 1024:
            raise ServiceError(400, "Update exceeds the experimental limit.")
        block = self._block_row(project_id, stable_id)
        row = self.db.execute("SELECT * FROM crdt_cells WHERE project_id = ? AND block_id = ?",
                              (project_id, stable_id)).fetchone()
        if (not row or not block["rich"] or row["epoch"] != epoch or row["version"] != version
                or block["version"] != version or row["quote"] != block["quote"]):
            raise ServiceError(409, "Collaboration checkpoint changed. Retain your local draft and reload the cell.")
        result = self._crdt_worker({"op": "apply", "snapshot": row["snapshot"], "update": update,
                                    "before": block["quote"]})
        if result["text"] == block["quote"]:
            raise ServiceError(409, "Update does not change the accepted cell.")
        # Both the source change and its snapshot commit in the same SQLite
        # transaction. A failed parser check must never persist the update.
        saved = self.direct_edit(actor, project_id, stable_id, version, block["quote"], result["text"],
                                 "source", crdt_checkpoint=(epoch, result["snapshot"], result["vector"]))
        return {**saved, "epoch": epoch, "snapshot": result["snapshot"], "vector": result["vector"]}

    def direct_edit(self, actor, project_id, stable_id, version, before, after, mode, crdt_checkpoint=None):
        """Human-only optimistic cell mutation; unrelated cells may advance independently."""
        self.require(actor, project_id, "direct")
        if mode not in {"visual", "source"} or type(version) is not int or version < 1 or not isinstance(before, str) or not isinstance(after, str):
            raise ServiceError(400, "Provide a cell version, before and after text, and editing mode.")
        if len(after.encode("utf-8")) > 512 * 1024:
            raise ServiceError(400, "Cell exceeds the editing limit.")
        block = self._block_row(project_id, stable_id)
        if version != block["version"] or before != block["quote"]:
            raise ServiceError(409, "This cell changed remotely. Your draft has not been saved.")
        if not block["rich"] and mode == "visual":
            raise ServiceError(400, "Use source mode for supported scientific cells.")
        file_row = self.db.execute("SELECT current, is_root FROM files WHERE project_id = ? AND path = ?",
                                   (project_id, block["path"])).fetchone()
        previous = self._blocks(project_id, block["path"])
        result = self._node({"op": "direct", "text": file_row["current"], "previous": previous,
                             "stableId": stable_id, "after": after, "mode": mode, "root": bool(file_row["is_root"])})
        if not result.get("ok"):
            raise ServiceError(409, result.get("error") or "This edit changes an unsupported boundary.")
        with self.db:
            self.db.execute("UPDATE files SET current = ?, dirty = 1 WHERE project_id = ? AND path = ?",
                            (result["text"], project_id, block["path"]))
            self._replace_blocks(project_id, block["path"], result["blocks"])
            revision = self._touch(project_id)
            self.db.execute("""UPDATE suggestions SET status = 'stale', result = 'stale'
                               WHERE project_id = ? AND block_id = ? AND status = 'pending'""",
                            (project_id, stable_id))
            if crdt_checkpoint is not None:
                epoch, snapshot, vector = crdt_checkpoint
                self.db.execute("""UPDATE crdt_cells SET version = ?, quote = ?, snapshot = ?, vector = ?
                                   WHERE project_id = ? AND block_id = ? AND epoch = ?""",
                                (version + 1, after, snapshot, vector, project_id, stable_id, epoch))
            else:
                self.db.execute("DELETE FROM crdt_cells WHERE project_id = ? AND block_id = ?", (project_id, stable_id))
            self._audit(actor["id"], "crdt-checkpoint" if crdt_checkpoint is not None else "direct-edit", project_id,
                        {"block": stable_id, "revision": revision, "mode": mode,
                         "before": before, "after": after, "base_version": version})
        return {"revision": revision, "block": next(b for b in self._blocks(project_id, block["path"])
                                                   if b["stableId"] == stable_id)}

    def propose(self, actor, project_id, block_id, base_revision, before, after, mode, evidence_ids=None):
        self.require(actor, project_id, "propose")
        if mode not in {"visual", "source"}:
            raise ServiceError(400, "A suggestion is either visual or source.")
        block = self._block_row(project_id, block_id)
        evidence_ids = evidence_ids or []
        status = "pending"
        result = "pending"
        if before != block["quote"] or not block["rich"]:
            status = "stale"
            result = "stale" if block["rich"] else "preserved"
        suggestion_id = str(uuid.uuid4())
        self.db.execute("""INSERT INTO suggestions (id, project_id, block_id, actor_id, mode, base_revision, before_quote, after_quote, status, result, evidence, decided_by, decided_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)""",
                        (suggestion_id, project_id, block_id, actor["id"], mode, base_revision, before, after, status, result, json.dumps(evidence_ids)))
        self._audit(actor["id"], "propose", project_id, {"suggestion": suggestion_id, "mode": mode, "kind": actor["kind"], "result": result})
        self.db.commit()
        return self._suggestion(suggestion_id)

    def _suggestion(self, suggestion_id):
        row = self.db.execute("""SELECT s.*, a.name AS actor_name, a.kind AS actor_kind FROM suggestions s
                                 JOIN actors a ON a.id = s.actor_id WHERE s.id = ?""", (suggestion_id,)).fetchone()
        return self._suggestion_view(row)

    def _suggestion_view(self, row):
        return {"id": row["id"], "project_id": row["project_id"], "block_id": row["block_id"], "actor_id": row["actor_id"],
                "actor_name": row["actor_name"], "actor_kind": row["actor_kind"], "mode": row["mode"],
                "base_revision": row["base_revision"], "before": row["before_quote"], "after": row["after_quote"],
                "status": row["status"], "result": row["result"], "evidence_ids": json.loads(row["evidence"]),
                "decided_by": row["decided_by"]}

    def _suggestions(self, project_id):
        rows = self._rows("""SELECT s.*, a.name AS actor_name, a.kind AS actor_kind FROM suggestions s
                             JOIN actors a ON a.id = s.actor_id WHERE s.project_id = ? ORDER BY s.rowid""", (project_id,))
        return [self._suggestion_view(row) for row in rows]

    def accept(self, actor, project_id, suggestion_id):
        self.require(actor, project_id, "decide")
        suggestion = self.db.execute("SELECT * FROM suggestions WHERE id = ? AND project_id = ?", (suggestion_id, project_id)).fetchone()
        if not suggestion:
            raise ServiceError(404, "Unknown suggestion.")
        if suggestion["status"] != "pending":
            raise ServiceError(409, "This suggestion is " + suggestion["status"] + ".")
        block = self._block_row(project_id, suggestion["block_id"])
        if suggestion["before_quote"] != block["quote"]:
            self._set_suggestion(suggestion_id, "stale", "stale", actor["id"])
            self.db.commit()
            raise ServiceError(409, "Another change reached this block first. The suggestion is stale and was not merged.")
        file_row = self.db.execute("SELECT current, is_root FROM files WHERE project_id = ? AND path = ?", (project_id, block["path"])).fetchone()
        previous = self._blocks(project_id, block["path"])
        result = self._node({"op": "apply", "text": file_row["current"], "previous": previous, "stableId": suggestion["block_id"],
                              "after": suggestion["after_quote"], "root": bool(file_row["is_root"])})
        if not result.get("ok"):
            self._set_suggestion(suggestion_id, "needs-review", "needs-review", actor["id"])
            self.db.commit()
            raise ServiceError(409, result.get("error") or "This change needs review.")
        self.db.execute("UPDATE files SET current = ?, dirty = 1 WHERE project_id = ? AND path = ?", (result["text"], project_id, block["path"]))
        self._replace_blocks(project_id, block["path"], result["blocks"])
        revision = self._touch(project_id)
        self._set_suggestion(suggestion_id, "accepted", "accepted", actor["id"])
        self.db.execute("""UPDATE suggestions SET status = 'stale', result = 'stale'
                           WHERE project_id = ? AND block_id = ? AND status = 'pending' AND id != ?""",
                        (project_id, suggestion["block_id"], suggestion_id))
        self._audit(actor["id"], "accept", project_id, {"suggestion": suggestion_id, "revision": revision, "mode": suggestion["mode"]})
        self.db.commit()
        return self._suggestion(suggestion_id)

    def reject(self, actor, project_id, suggestion_id):
        self.require(actor, project_id, "decide")
        suggestion = self.db.execute("SELECT id, status FROM suggestions WHERE id = ? AND project_id = ?", (suggestion_id, project_id)).fetchone()
        if not suggestion:
            raise ServiceError(404, "Unknown suggestion.")
        if suggestion["status"] != "pending":
            raise ServiceError(409, "This suggestion is " + suggestion["status"] + ".")
        self._set_suggestion(suggestion_id, "rejected", "rejected", actor["id"])
        self._audit(actor["id"], "reject", project_id, {"suggestion": suggestion_id})
        self.db.commit()
        return self._suggestion(suggestion_id)

    def _set_suggestion(self, suggestion_id, status, result, decided_by):
        self.db.execute("UPDATE suggestions SET status = ?, result = ?, decided_by = ?, decided_at = ? WHERE id = ?",
                        (status, result, decided_by, self.now(), suggestion_id))

    def move_block(self, actor, project_id, stable_id, to_offset):
        self.require(actor, project_id, "propose")
        block = self._block_row(project_id, stable_id)
        file_row = self.db.execute("SELECT current, is_root FROM files WHERE project_id = ? AND path = ?", (project_id, block["path"])).fetchone()
        previous = self._blocks(project_id, block["path"])
        result = self._node({"op": "move", "text": file_row["current"], "previous": previous, "stableId": stable_id,
                              "toOffset": int(to_offset), "root": bool(file_row["is_root"])})
        if not result.get("ok"):
            raise ServiceError(409, result.get("error") or "The move needs review.")
        self.db.execute("UPDATE files SET current = ?, dirty = 1 WHERE project_id = ? AND path = ?", (result["text"], project_id, block["path"]))
        self._replace_blocks(project_id, block["path"], result["blocks"])
        revision = self._touch(project_id)
        self.db.execute("UPDATE suggestions SET status = 'stale', result = 'stale' WHERE project_id = ? AND block_id = ? AND status = 'pending'",
                        (project_id, stable_id))
        self._audit(actor["id"], "move", project_id, {"block": stable_id, "revision": revision})
        self.db.commit()
        return {"stableId": stable_id, "revision": revision, "unresolved": result.get("unresolved") or []}

    def create_anchor(self, actor, project_id, block_id):
        self.require(actor, project_id, "comment")
        block = self._block_row(project_id, block_id)
        project = self.db.execute("SELECT revision FROM projects WHERE id = ?", (project_id,)).fetchone()
        anchor_id = str(uuid.uuid4())
        self.db.execute("""INSERT INTO anchors (id, project_id, block_id, quote, actor_id, created_revision, dismissed)
                           VALUES (?, ?, ?, ?, ?, ?, 0)""",
                        (anchor_id, project_id, block_id, block["quote"], actor["id"], project["revision"]))
        self._audit(actor["id"], "anchor", project_id, {"anchor": anchor_id, "block": block_id})
        self.db.commit()
        return self._anchor_view(project_id, self.db.execute("SELECT * FROM anchors WHERE id = ?", (anchor_id,)).fetchone())

    def _anchor_view(self, project_id, row):
        blocks = self._blocks(project_id)
        resolved = self._node({"op": "resolve", "blocks": blocks, "anchor": {"blockId": row["block_id"], "quote": row["quote"]}})
        return {"id": row["id"], "block_id": row["block_id"], "quote": row["quote"], "dismissed": bool(row["dismissed"]),
                "status": "dismissed" if row["dismissed"] else resolved["status"], "path": resolved.get("path")}

    def dismiss_anchor(self, actor, project_id, anchor_id):
        self.require(actor, project_id, "dismiss")
        self.db.execute("UPDATE anchors SET dismissed = 1 WHERE id = ? AND project_id = ?", (anchor_id, project_id))
        self._audit(actor["id"], "dismiss-anchor", project_id, {"anchor": anchor_id})
        self.db.commit()
        return {"id": anchor_id, "dismissed": True}

    def comment(self, actor, project_id, anchor_id, body):
        self.require(actor, project_id, "comment")
        anchor = self.db.execute("SELECT id FROM anchors WHERE id = ? AND project_id = ?", (anchor_id, project_id)).fetchone()
        if not anchor:
            raise ServiceError(404, "Unknown anchor.")
        if not body.strip():
            raise ServiceError(400, "A comment needs text.")
        comment_id = str(uuid.uuid4())
        self.db.execute("INSERT INTO comments (id, project_id, anchor_id, actor_id, body, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)",
                        (comment_id, project_id, anchor_id, actor["id"], body.strip(), self.now()))
        self._audit(actor["id"], "comment", project_id, {"comment": comment_id, "anchor": anchor_id})
        self.db.commit()
        return {"id": comment_id, "anchor_id": anchor_id, "body": body.strip(), "status": "open"}

    def resolve_comment(self, actor, project_id, comment_id):
        self.require(actor, project_id, "decide")
        self.db.execute("UPDATE comments SET status = 'resolved' WHERE id = ? AND project_id = ?", (comment_id, project_id))
        self._audit(actor["id"], "resolve-comment", project_id, {"comment": comment_id})
        self.db.commit()
        return {"id": comment_id, "status": "resolved"}

    def add_object(self, actor, project_id, kind, title, body, external=None):
        self.require(actor, project_id, "propose")
        if kind not in {"source", "dataset", "code", "notebook", "run", "figure", "note", "claim"}:
            raise ServiceError(400, "Unsupported research object.")
        if external:
            holding = external.get("holding")
            if holding not in {"reference", "cache", "copy"}:
                raise ServiceError(400, "Say whether this is a reference, an authorised cache, or a copy.")
            for key in ("system", "identifier", "version", "access"):
                if not str(external.get(key) or "").strip():
                    raise ServiceError(400, "An external object needs a system, identifier, version and access rule.")
        object_id = self._add_object(actor, project_id, kind, title, body, actor["id"], external or {})
        self.db.commit()
        return self._object_view(self._row_object(object_id))

    def _add_object(self, actor, project_id, kind, title, body, owner_id, external):
        object_id = str(uuid.uuid4())
        payload = json.dumps(external)
        self.db.execute("""INSERT INTO objects (id, project_id, kind, title, body, owner_id, external, revision)
                           VALUES (?, ?, ?, ?, ?, ?, ?, 1)""", (object_id, project_id, kind, title, body, owner_id, payload))
        self.db.execute("INSERT INTO object_versions (object_id, revision, title, body, external) VALUES (?, 1, ?, ?, ?)",
                        (object_id, title, body, payload))
        self._audit(actor["id"], "object", project_id, {"object": object_id, "kind": kind})
        return object_id

    def _row_object(self, object_id):
        return self.db.execute("SELECT * FROM objects WHERE id = ?", (object_id,)).fetchone()

    def _object_view(self, row):
        return {"id": row["id"], "kind": row["kind"], "title": row["title"], "body": row["body"], "owner_id": row["owner_id"],
                "revision": row["revision"], "external": json.loads(row["external"] or "{}")}

    def update_object(self, actor, project_id, object_id, body):
        self.require(actor, project_id, "propose")
        row = self.db.execute("SELECT * FROM objects WHERE id = ? AND project_id = ?", (object_id, project_id)).fetchone()
        if not row:
            raise ServiceError(404, "Unknown object.")
        revision = row["revision"] + 1
        self.db.execute("UPDATE objects SET body = ?, revision = ? WHERE id = ?", (body, revision, object_id))
        self.db.execute("INSERT INTO object_versions (object_id, revision, title, body, external) VALUES (?, ?, ?, ?, ?)",
                        (object_id, revision, row["title"], body, row["external"]))
        self._audit(actor["id"], "revise-object", project_id, {"object": object_id, "revision": revision})
        self.db.commit()
        return self._object_view(self._row_object(object_id))

    def link_claim(self, actor, project_id, claim_id, evidence_id, anchor_id=None):
        self.require(actor, project_id, "propose")
        claim = self.db.execute("SELECT id, kind FROM objects WHERE id = ? AND project_id = ?", (claim_id, project_id)).fetchone()
        evidence = self.db.execute("SELECT id, revision FROM objects WHERE id = ? AND project_id = ?", (evidence_id, project_id)).fetchone()
        if not claim or claim["kind"] != "claim" or not evidence:
            raise ServiceError(400, "Link a claim to an evidence object in this project.")
        if anchor_id and not self.db.execute("SELECT 1 FROM anchors WHERE id = ? AND project_id = ?", (anchor_id, project_id)).fetchone():
            raise ServiceError(404, "Unknown anchor.")
        link_id = str(uuid.uuid4())
        self.db.execute("INSERT INTO links (id, project_id, claim_id, evidence_id, evidence_revision, anchor_id) VALUES (?, ?, ?, ?, ?, ?)",
                        (link_id, project_id, claim_id, evidence_id, evidence["revision"], anchor_id))
        self._audit(actor["id"], "link", project_id, {"link": link_id, "evidence_revision": evidence["revision"]})
        self.db.commit()
        return self._link_view(self.db.execute("SELECT * FROM links WHERE id = ?", (link_id,)).fetchone())

    def _link_view(self, row):
        current = self.db.execute("SELECT revision FROM objects WHERE id = ?", (row["evidence_id"],)).fetchone()
        anchor_status = None
        if row["anchor_id"]:
            anchor = self.db.execute("SELECT * FROM anchors WHERE id = ?", (row["anchor_id"],)).fetchone()
            anchor_status = self._anchor_view(row["project_id"], anchor)["status"]
        return {"id": row["id"], "claim_id": row["claim_id"], "evidence_id": row["evidence_id"],
                "evidence_revision": row["evidence_revision"], "current_revision": current["revision"] if current else None,
                "changed": bool(current and current["revision"] != row["evidence_revision"]), "anchor_id": row["anchor_id"],
                "anchor_status": anchor_status}

    def add_decision(self, actor, project_id, text):
        self.require(actor, project_id, "decide_record")
        decision_id = str(uuid.uuid4())
        self.db.execute("INSERT INTO decisions (id, project_id, text, status, actor_id, created_at) VALUES (?, ?, ?, 'open', ?, ?)",
                        (decision_id, project_id, text.strip(), actor["id"], self.now()))
        self._audit(actor["id"], "decision", project_id, {"decision": decision_id})
        self.db.commit()
        return {"id": decision_id, "text": text.strip(), "status": "open"}

    def close_decision(self, actor, project_id, decision_id, status):
        self.require(actor, project_id, "decide_record")
        if status not in {"accepted", "deferred"}:
            raise ServiceError(400, "Close a decision as accepted or deferred.")
        self.db.execute("UPDATE decisions SET status = ? WHERE id = ? AND project_id = ?", (status, decision_id, project_id))
        self._audit(actor["id"], "close-decision", project_id, {"decision": decision_id, "status": status})
        self.db.commit()
        return {"id": decision_id, "status": status}

    def release(self, actor, project_id):
        self.require(actor, project_id, "release")
        detail = self.project(actor, project_id)
        if not detail["readiness"]["ready"]:
            raise ServiceError(409, "Resolve pending suggestions, unresolved anchors and open decisions before release.")
        revision = detail["revision"]
        release_id = str(uuid.uuid4())
        files = self._export_map(project_id)
        manifest = {"revision": revision, "project_id": project_id, "title": detail["title"], "released_by": actor["id"],
                    "members": detail["members"], "decisions": detail["decisions"], "links": detail["links"],
                    "suggestions": detail["suggestions"], "objects": detail["objects"], "block_ids": [block["stableId"] for block in detail["blocks"]]}
        self.db.execute("INSERT INTO releases (id, project_id, revision, actor_id, manifest, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                        (release_id, project_id, revision, actor["id"], json.dumps(manifest), self.now()))
        for path, data in files.items():
            self.db.execute("INSERT INTO release_files (release_id, path, bytes) VALUES (?, ?, ?)", (release_id, path, data))
        self._audit(actor["id"], "release", project_id, {"release": release_id, "revision": revision})
        self.db.commit()
        return {"id": release_id, "revision": revision}

    def release_zip(self, actor, project_id, release_id):
        self.require(actor, project_id, "read")
        row = self.db.execute("SELECT manifest FROM releases WHERE id = ? AND project_id = ?", (release_id, project_id)).fetchone()
        if not row:
            raise ServiceError(404, "Unknown release.")
        files = {item["path"]: item["bytes"] for item in self._rows("SELECT path, bytes FROM release_files WHERE release_id = ?", (release_id,))}
        files["papercolab/manifest.json"] = (row["manifest"] + "\n").encode()
        return zip_bytes(files), json.loads(row["manifest"])

    def export_zip(self, actor, project_id):
        self.require(actor, project_id, "read")
        return zip_bytes(self._export_map(project_id))

    def _export_map(self, project_id):
        files = {}
        for row in self._rows("SELECT path, original, current, is_text, dirty FROM files WHERE project_id = ?", (project_id,)):
            files[row["path"]] = row["current"].encode("utf-8") if row["dirty"] and row["is_text"] else row["original"]
        return files

    def search(self, actor, query):
        if actor["revoked"]:
            raise ServiceError(403, "This actor is revoked.")
        needle = query.strip()
        if not needle:
            return []
        like = "%" + needle.replace("%", "") + "%"
        rows = self._rows("""SELECT p.id AS project_id, p.title AS project, o.kind, o.title, o.id FROM objects o
                             JOIN projects p ON p.id = o.project_id JOIN members m ON m.project_id = p.id
                             WHERE m.actor_id = ? AND (o.title LIKE ? OR o.body LIKE ?) LIMIT 50""", (actor["id"], like, like))
        return [dict(row) for row in rows]

    def create_collection(self, actor, name, project_ids):
        if actor["revoked"] or actor["kind"] == "assistant":
            raise ServiceError(403, "A person creates a collection.")
        collection_id = str(uuid.uuid4())
        self.db.execute("INSERT INTO collections (id, name, actor_id) VALUES (?, ?, ?)", (collection_id, name.strip() or "Collection", actor["id"]))
        for project_id in project_ids:
            self.require(actor, project_id, "read")
            self.db.execute("INSERT INTO collection_projects (collection_id, project_id) VALUES (?, ?)", (collection_id, project_id))
        self._audit(actor["id"], "collection", None, {"collection": collection_id})
        self.db.commit()
        return {"id": collection_id, "name": name, "projects": list(project_ids)}

    def audit(self, actor, project_id=None):
        if project_id:
            self.require(actor, project_id, "read")
            rows = self._rows("SELECT * FROM audit WHERE project_id = ? ORDER BY id", (project_id,))
        else:
            self.require(actor, None, "cost")
            rows = self._rows("SELECT * FROM audit ORDER BY id")
        return [{"at": row["at"], "actor_id": row["actor_id"], "action": row["action"], "project_id": row["project_id"],
                 "detail": json.loads(row["detail"])} for row in rows]

    def cost(self, actor):
        self.require(actor, None, "cost")
        return {"database_bytes": self.path.stat().st_size if self.path.exists() else 0,
                "projects": self.db.execute("SELECT count(*) AS n FROM projects").fetchone()["n"],
                "stored_file_bytes": self.db.execute("SELECT coalesce(sum(length(original)), 0) AS n FROM files").fetchone()["n"],
                "note": "One SQLite file on the machine running PaperColab. Released snapshots are included in the database size."}

    def backup(self, actor):
        self.require(actor, None, "backup")
        handle, name = tempfile.mkstemp(suffix=".sqlite")
        os.close(handle)
        copy = sqlite3.connect(name)
        try:
            self.db.backup(copy)
        finally:
            copy.close()
        data = Path(name).read_bytes()
        Path(name).unlink(missing_ok=True)
        self._audit(actor["id"], "backup", None, {"bytes": len(data)})
        self.db.commit()
        return data

    def restore(self, actor, blob):
        self.require(actor, None, "restore")
        probe = sqlite3.connect(":memory:")
        try:
            probe.deserialize(blob) if hasattr(probe, "deserialize") else None
        finally:
            probe.close()
        # Validate by opening a temporary copy and reading the policy table.
        handle, name = tempfile.mkstemp(suffix=".sqlite")
        os.close(handle)
        Path(name).write_bytes(blob)
        check = sqlite3.connect(name)
        try:
            check.execute("SELECT allow_ai FROM policy").fetchone()
        except sqlite3.Error as error:
            check.close()
            Path(name).unlink(missing_ok=True)
            raise ServiceError(400, "That backup is not a PaperColab database.") from error
        check.close()
        self.db.close()
        shutil.copyfile(name, self.path)
        Path(name).unlink(missing_ok=True)
        self.db = sqlite3.connect(self.path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self._schema()
        self.db.execute("DELETE FROM crdt_cells")
        self._audit(actor["id"], "restore", None, {"bytes": len(blob)})
        self.db.commit()
        return {"restored": True}

    def purge(self, actor):
        self.require(actor, None, "purge")
        days = self.policy()["retention_days"]
        if days <= 0:
            return {"removed": []}
        cutoff = self.now() - days * 86400
        removed = []
        for row in self._rows("""SELECT p.id FROM projects p WHERE p.updated_at < ? AND NOT EXISTS
                                 (SELECT 1 FROM releases r WHERE r.project_id = p.id)""", (cutoff,)):
            self._delete_project(row["id"])
            removed.append(row["id"])
        self._audit(actor["id"], "purge", None, {"removed": removed})
        self.db.commit()
        return {"removed": removed}

    def _delete_project(self, project_id):
        for table in ("members", "blocks", "files", "suggestions", "anchors", "comments", "links", "decisions", "crdt_cells"):
            self.db.execute(f"DELETE FROM {table} WHERE project_id = ?", (project_id,))
        self.db.execute("DELETE FROM object_versions WHERE object_id IN (SELECT id FROM objects WHERE project_id = ?)", (project_id,))
        self.db.execute("DELETE FROM objects WHERE project_id = ?", (project_id,))
        for release in self._rows("SELECT id FROM releases WHERE project_id = ?", (project_id,)):
            self.db.execute("DELETE FROM release_files WHERE release_id = ?", (release["id"],))
        self.db.execute("DELETE FROM releases WHERE project_id = ?", (project_id,))
        self.db.execute("DELETE FROM projects WHERE id = ?", (project_id,))

    def mcp(self, actor, tool, arguments):
        arguments = arguments or {}
        if tool == "list_projects":
            return self.projects(actor)
        if tool == "list_blocks":
            detail = self.project(actor, arguments["project"])
            return detail["blocks"]
        if tool == "read_block":
            self.require(actor, arguments["project"], "read")
            row = self._block_row(arguments["project"], arguments["block"])
            return {"stableId": row["stable_id"], "path": row["path"], "kind": row["kind"], "quote": row["quote"]}
        if tool == "comment":
            anchor = self.create_anchor(actor, arguments["project"], arguments["block"])
            return self.comment(actor, arguments["project"], anchor["id"], arguments.get("body") or "")
        if tool == "propose":
            return self.propose(actor, arguments["project"], arguments["block"], arguments["base_revision"],
                                arguments["before"], arguments["after"], arguments.get("mode") or "source", arguments.get("evidence_ids"))
        raise ServiceError(404, "Unknown tool. Available tools: list_projects, list_blocks, read_block, comment, propose.")


def bib_entries(text):
    entries = []
    for match in re.finditer(r"@(\w+)\s*\{\s*([^,\s]+)\s*,", text):
        raw_start = match.start()
        raw = text[raw_start:text.find("\n@", raw_start + 1) if "\n@" in text[raw_start + 1:] else len(text)].strip()
        title_match = re.search(r"title\s*=\s*[{\"](.*?)[}\"]", raw, re.I | re.S)
        title = " ".join(title_match.group(1).split()) if title_match else match.group(2)
        entries.append({"key": match.group(2), "title": title, "raw": raw})
    return entries


def zip_bytes(files):
    import io
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for path, data in sorted(files.items()):
            info = zipfile.ZipInfo(path)
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)
    return buffer.getvalue()
