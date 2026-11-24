from contextlib import closing
from hashlib import sha256
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
import zipfile

from server.http_app import Api
from server.service import Service, ServiceError


def load(path):
    service = Service(path, demo=True)
    actors = {name: service.actor_by_token(token) for name, token in
              (("ada", "demo-ada"), ("bao", "demo-bao"), ("iris", "demo-iris"), ("quill", "demo-quill"))}
    project = service.projects(actors["ada"])[0]["id"]
    return service, actors, project


def paragraph(service, actor, project):
    detail = service.project(actor, project)
    return next(block for block in detail["blocks"] if block["rich"] and "two readings" in block["quote"])


class ProductTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.service, self.actors, self.project = load(Path(self.tmp.name) / "paper.sqlite")

    def tearDown(self):
        self.service.close()
        self.tmp.cleanup()

    def test_human_and_assistant_keys_are_stored_only_as_hashes(self):
        ada = self.actors["ada"]
        api = Api(self.service)
        credentials = []
        for kind in ("human", "assistant"):
            with self.subTest(kind=kind):
                created = self.service.create_actor(ada, "New " + kind, kind)
                key = created["token"]
                credentials.append(key)
                stored = self.service.db.execute("SELECT token_hash FROM actors WHERE id = ?", (created["id"],)).fetchone()
                self.assertEqual(stored["token_hash"], sha256(key.encode()).digest())
                status, actor = api.handle("GET", "/api/me", {"authorization": "Bearer " + key}, b"")
                self.assertEqual(status, 200)
                self.assertEqual(actor["id"], created["id"])
                self.assertNotIn("token", actor)
                with self.assertRaises(ServiceError):
                    self.service.actor_by_token(stored["token_hash"].hex())
        backup = self.service.backup(ada)
        for key in credentials:
            self.assertNotIn(key.encode(), backup)

    def test_plaintext_credentials_migrate_on_startup_and_restore(self):
        ada = self.actors["ada"]
        member = self.service.create_actor(ada, "Legacy assistant", "assistant")
        keys = {self.actors["ada"]["id"]: "demo-ada", self.actors["bao"]["id"]: "demo-bao",
                self.actors["iris"]["id"]: "demo-iris", self.actors["quill"]["id"]: "demo-quill",
                member["id"]: member["token"]}
        legacy = Path(self.tmp.name) / "plaintext.sqlite"
        legacy.write_bytes(self.service.backup(ada))
        with closing(sqlite3.connect(legacy)) as db, db:
            db.execute("ALTER TABLE actors RENAME COLUMN token_hash TO token")
            db.executemany("UPDATE actors SET token = ? WHERE id = ?", ((key, actor_id) for actor_id, key in keys.items()))
        original_backup = legacy.read_bytes()
        for key in keys.values():
            self.assertIn(key.encode(), original_backup)

        def check_credentials(service):
            for actor_id, key in keys.items():
                self.assertEqual(service.actor_by_token(key)["id"], actor_id)
                self.assertNotIn(key.encode(), service.path.read_bytes())
            columns = {row["name"] for row in service.db.execute("PRAGMA table_info(actors)")}
            self.assertIn("token_hash", columns)
            self.assertNotIn("token", columns)

        with closing(Service(legacy)) as upgraded:
            check_credentials(upgraded)
        with closing(Service(legacy)) as reopened:
            check_credentials(reopened)
        with self.assertRaises(ServiceError) as invalid:
            self.service.restore(ada, b"not a SQLite database")
        self.assertEqual(invalid.exception.status, 400)
        self.assertEqual(self.service.actor_by_token("demo-ada")["id"], ada["id"])
        self.service.restore(ada, original_backup)
        check_credentials(self.service)
        upgraded_backup = self.service.backup(ada)
        for key in keys.values():
            self.assertNotIn(key.encode(), upgraded_backup)
        with closing(Service(Path(self.tmp.name) / "production.sqlite")) as production:
            key = "test-only-operator-key-for-restore"
            operator_id = production._insert_actor("Operator", "human", key, "operator")
            production.db.commit()
            operator = production.actor_by_token(key)
            for demo_backup in (original_backup, upgraded_backup):
                with self.assertRaises(ServiceError) as rejected:
                    production.restore(operator, demo_backup)
                self.assertEqual(rejected.exception.status, 400)
                self.assertEqual(production.actor_by_token(key)["id"], operator_id)

    def test_visual_and_source_share_one_review_record_until_a_person_accepts(self):
        block = paragraph(self.service, self.actors["bao"], self.project)
        detail = self.service.project(self.actors["ada"], self.project)
        before_zip = self.service.export_zip(self.actors["ada"], self.project)
        visual = self.service.propose(self.actors["bao"], self.project, block["stableId"], detail["revision"],
                                      block["quote"], block["quote"].replace("two readings", "three readings"), "visual")
        source = self.service.propose(self.actors["ada"], self.project, block["stableId"], detail["revision"],
                                      block["quote"], block["quote"].replace("two readings", "four readings"), "source")
        self.assertEqual(set(visual) , set(source))
        self.assertEqual(visual["actor_kind"], "human")
        self.assertEqual(visual["status"], "pending")
        self.assertEqual(source["status"], "pending")
        self.assertEqual(self.service.export_zip(self.actors["ada"], self.project), before_zip)
        accepted = self.service.accept(self.actors["iris"], self.project, visual["id"])
        self.assertEqual(accepted["status"], "accepted")
        exported = text_of(self.service.export_zip(self.actors["ada"], self.project), "estuary/sections/methods.tex")
        self.assertIn("three readings", exported)
        self.assertIn("Upstream", exported)
        with self.assertRaises(ServiceError) as caught:
            self.service.accept(self.actors["iris"], self.project, source["id"])
        self.assertEqual(caught.exception.status, 409)
        self.assertIn("three readings", text_of(self.service.export_zip(self.actors["ada"], self.project), "estuary/sections/methods.tex"))
        self.assertNotIn("four readings", text_of(self.service.export_zip(self.actors["ada"], self.project), "estuary/sections/methods.tex"))

    def test_offline_overlap_on_another_block_can_still_be_accepted(self):
        detail = self.service.project(self.actors["ada"], self.project)
        heading = next(block for block in detail["blocks"] if block["kind"] == "heading")
        prose = paragraph(self.service, self.actors["bao"], self.project)
        first = self.service.propose(self.actors["bao"], self.project, heading["stableId"], detail["revision"],
                                     heading["quote"], heading["quote"].replace("Sampling", "Station"), "source")
        second = self.service.propose(self.actors["ada"], self.project, prose["stableId"], detail["revision"],
                                      prose["quote"], prose["quote"].replace("two readings", "paired readings"), "visual")
        self.service.accept(self.actors["iris"], self.project, first["id"])
        self.service.accept(self.actors["ada"], self.project, second["id"])
        exported = text_of(self.service.export_zip(self.actors["ada"], self.project), "estuary/sections/methods.tex")
        self.assertIn("Station method", exported)
        self.assertIn("paired readings", exported)

    def test_a_stale_reconnect_does_not_change_the_manuscript(self):
        detail = self.service.project(self.actors["bao"], self.project)
        block = paragraph(self.service, self.actors["bao"], self.project)
        live = self.service.propose(self.actors["ada"], self.project, block["stableId"], detail["revision"],
                                    block["quote"], block["quote"].replace("two readings", "three readings"), "visual")
        self.service.accept(self.actors["iris"], self.project, live["id"])
        stale = self.service.propose(self.actors["bao"], self.project, block["stableId"], detail["revision"],
                                     block["quote"], block["quote"] + " Extra.", "source")
        self.assertEqual(stale["result"], "stale")
        exported = text_of(self.service.export_zip(self.actors["ada"], self.project), "estuary/sections/methods.tex")
        self.assertIn("three readings", exported)
        self.assertNotIn("Extra.", exported)

    def test_block_revision_detects_changed_then_restored_text(self):
        ada, bao, iris = (self.actors[name] for name in ("ada", "bao", "iris"))
        detail = self.service.project(bao, self.project)
        original = paragraph(self.service, bao, self.project)
        block_id = original["stableId"]
        edited = original["quote"].replace("two readings", "three readings")
        change = self.service.propose(ada, self.project, block_id, detail["revision"],
                                      original["quote"], edited, "visual", base_block_revision=original["revision"])
        self.service.accept(iris, self.project, change["id"])
        current = self.service.project(bao, self.project)
        restore = self.service.propose(ada, self.project, block_id, current["revision"],
                                       edited, original["quote"], "source", base_block_revision=current["revision"])
        self.service.accept(iris, self.project, restore["id"])
        restored = paragraph(self.service, bao, self.project)
        self.assertEqual(restored["stableId"], block_id)
        self.assertGreater(restored["revision"], original["revision"])
        for explicit in ({}, {"base_block_revision": original["revision"]}):
            with self.subTest(explicit=explicit):
                stale = self.service.propose(bao, self.project, block_id, detail["revision"], original["quote"],
                                             original["quote"] + " Offline entry.", "source", **explicit)
                self.assertEqual(stale["status"], "stale")
                self.assertEqual(stale["after"], original["quote"] + " Offline entry.")

    def test_owner_revision_and_assistant_policy_survive_edits_and_moves(self):
        ada, bao, iris, quill = (self.actors[name] for name in ("ada", "bao", "iris", "quill"))
        project_id = self.service.create_project(ada, "Pilot", example=True)["id"]
        self.service.add_member(ada, project_id, bao["id"], "author")
        self.service.add_member(ada, project_id, iris["id"], "reviewer")
        self.service.add_member(ada, project_id, quill["id"], "author")
        member = self.service.create_actor(ada, "Ren", "human")
        ren = self.service.actor_by_token(member["token"])
        self.service.add_member(ada, project_id, ren["id"], "author")
        original = paragraph(self.service, bao, project_id)
        self.assertFalse(original["allow_ai"])
        self.service.assign_owner(ada, project_id, original["stableId"], bao["id"])
        block = paragraph(self.service, bao, project_id)
        block_id = block["stableId"]
        proposed = block["quote"] + " Ready for review."
        for actor in (ren, quill):
            self.assertFalse(paragraph(self.service, actor, project_id)["can_propose"])
            with self.assertRaises(ServiceError) as caught:
                self.service.propose(actor, project_id, block_id, block["revision"], block["quote"], proposed, "source")
            self.assertEqual(caught.exception.status, 403)
        self.assertTrue(block["can_propose"])
        with self.assertRaises(ServiceError):
            self.service.set_block_ai(bao, project_id, block_id, True)
        opted_in = self.service.set_block_ai(ada, project_id, block_id, True)
        proposal = self.service.mcp(quill, "propose", {"project": project_id, "block": block_id,
                                    "base_revision": opted_in["revision"], "base_block_revision": opted_in["revision"],
                                    "before": block["quote"], "after": proposed})
        self.assertEqual(proposal["status"], "pending")
        self.assertTrue(self.service.project(iris, project_id)["suggestions"][0]["can_decide"])
        self.assertFalse(self.service.project(bao, project_id)["suggestions"][0]["can_decide"])
        self.service.accept(iris, project_id, proposal["id"])
        changed = paragraph(self.service, bao, project_id)
        self.assertGreater(changed["revision"], opted_in["revision"])
        self.assertEqual(changed["owner_id"], bao["id"])
        self.assertTrue(changed["allow_ai"])
        text = self.service.file_text(ada, project_id, block["path"])["text"]
        moved = self.service.move_block(ada, project_id, block_id, len(text))
        updated = paragraph(self.service, bao, project_id)
        self.assertEqual(updated["revision"], moved["revision"])
        self.assertEqual(updated["stableId"], block_id)
        self.assertEqual(updated["owner_id"], bao["id"])
        self.assertTrue(updated["allow_ai"])
        self.assertEqual(updated["quote"], proposed)
        pending = self.service.propose(quill, project_id, block_id, moved["revision"], proposed,
                                        proposed + " Another change.", "source", base_block_revision=updated["revision"])
        self.service.set_block_ai(ada, project_id, block_id, False)
        with self.assertRaises(ServiceError) as caught:
            self.service.accept(iris, project_id, pending["id"])
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(paragraph(self.service, bao, project_id)["quote"], proposed)

    def test_structural_changes_require_a_lead_and_supersede_prior_proposals(self):
        ada, bao, iris, quill = (self.actors[name] for name in ("ada", "bao", "iris", "quill"))
        detail = self.service.project(bao, self.project)
        block = paragraph(self.service, bao, self.project)
        blob = self.service.export_zip(ada, self.project)
        text = self.service.file_text(ada, self.project, block["path"])["text"]
        for actor in (bao, iris, quill):
            with self.assertRaises(ServiceError) as caught:
                self.service.move_block(actor, self.project, block["stableId"], len(text))
            self.assertEqual(caught.exception.status, 403)
            with self.assertRaises(ServiceError) as caught:
                self.service.import_zip(actor, self.project, blob)
            self.assertEqual(caught.exception.status, 403)
        suggestion = self.service.propose(bao, self.project, block["stableId"], detail["revision"],
                                          block["quote"], block["quote"] + " Draft.", "source")
        with self.assertRaises(sqlite3.IntegrityError):
            self.service.import_files(ada, self.project, [("main.tex", b"First."), ("main.tex", b"Duplicate.")])
        self.assertEqual(self.service.export_zip(ada, self.project), blob)
        self.assertEqual(self.service.project(bao, self.project)["suggestions"][0]["status"], "pending")
        reimported = self.service.import_zip(ada, self.project, blob)
        self.assertEqual(reimported["suggestions"][0]["id"], suggestion["id"])
        self.assertEqual(reimported["suggestions"][0]["status"], "stale")
        self.assertEqual(paragraph(self.service, bao, self.project)["stableId"], block["stableId"])
        self.assertGreater(paragraph(self.service, bao, self.project)["revision"], block["revision"])

    def test_relative_cell_move_checks_both_revisions_and_preserves_protected_source(self):
        ada, bao, iris = (self.actors[name] for name in ("ada", "bao", "iris"))
        source = b"First.\r\n\r\n\\begin{verbatim}\r\nOriginal\r\n\r\n\r\ntext\r\n\\end{verbatim}\r\n\r\nSecond.\r\n"
        detail = self.service.import_files(ada, self.project, [("notes.tex", source), ("other.tex", b"Other.")])
        first = next(block for block in detail["blocks"] if block["quote"] == "First.")
        raw = next(block for block in detail["blocks"] if block["kind"] == "raw")
        second = next(block for block in detail["blocks"] if block["quote"] == "Second.")
        other = next(block for block in detail["blocks"] if block["path"] == "other.tex")
        assignment = self.service.assign_owner(ada, self.project, first["stableId"], bao["id"])
        anchor = self.service.create_anchor(iris, self.project, first["stableId"])
        pending = self.service.propose(bao, self.project, first["stableId"], assignment["revision"], "First.", "First draft.", "source")
        options = {"neighbor_id": second["stableId"], "direction": "after",
                   "base_block_revision": assignment["revision"], "base_neighbor_revision": second["revision"]}
        for changes, status in (({"base_block_revision": first["revision"]}, 409),
                                ({"base_neighbor_revision": second["revision"] + 1}, 409),
                                ({"neighbor_id": other["stableId"]}, 400),
                                ({"base_neighbor_revision": None}, 400)):
            with self.subTest(changes=changes):
                with self.assertRaises(ServiceError) as caught:
                    self.service.move_block(ada, self.project, first["stableId"], **(options | changes))
                self.assertEqual(caught.exception.status, status)
        with self.assertRaises(ServiceError) as caught:
            self.service.move_block(bao, self.project, first["stableId"], **options)
        self.assertEqual(caught.exception.status, 403)
        self.assertEqual(self.service.file_text(ada, self.project, "notes.tex")["text"].encode(), source)
        moved = self.service.move_block(ada, self.project, first["stableId"], **options)
        detail = self.service.project(ada, self.project)
        raw_after, second_after, first_after = [block for block in detail["blocks"] if block["path"] == "notes.tex"]
        self.assertEqual([raw_after["stableId"], second_after["stableId"], first_after["stableId"]],
                         [raw["stableId"], second["stableId"], first["stableId"]])
        self.assertEqual(raw_after["quote"], raw["quote"])
        self.assertEqual(second_after["revision"], second["revision"])
        self.assertEqual(first_after["revision"], moved["revision"])
        self.assertEqual(first_after["owner_id"], bao["id"])
        self.assertEqual(detail["anchors"][0]["id"], anchor["id"])
        self.assertEqual(detail["anchors"][0]["status"], "exact")
        self.assertEqual(detail["suggestions"][0]["id"], pending["id"])
        self.assertEqual(detail["suggestions"][0]["status"], "stale")
        exported = self.service.file_text(ada, self.project, "notes.tex")["text"].encode()
        expected = source.replace(b"First.", b"", 1).replace(b"Second.", b"Second.\r\n\r\nFirst.\r\n\r\n", 1)
        self.assertEqual(exported, expected)

    def test_starter_project_has_an_editable_title_and_paragraph(self):
        ada = self.actors["ada"]
        empty = self.service.create_project(ada, "Upload later")
        self.assertEqual(empty["files"], [])
        starter = self.service.create_project(ada, "Trials & taxes {2026} #2", starter=True)
        self.assertEqual([file["path"] for file in starter["files"]], ["main.tex"])
        self.assertTrue(starter["files"][0]["is_root"])
        title, paragraph = [block for block in starter["blocks"] if block["rich"]]
        self.assertEqual(title["kind"], "heading")
        self.assertEqual(title["quote"], r"\section*{Trials \& taxes \{2026\} \#2}")
        self.assertEqual(paragraph["kind"], "paragraph")
        self.assertEqual(title["revision"], starter["revision"])
        exported = text_of(self.service.export_zip(ada, starter["id"]), "main.tex")
        self.assertIn(r"\documentclass{article}", exported)
        self.assertIn(paragraph["quote"], exported)

    def test_manuscript_preview_bundles_every_file_and_overlays_drafts_across_cells(self):
        ada, bao, iris = (self.actors[name] for name in ("ada", "bao", "iris"))
        main = (b"\\documentclass{article}\r\n\\begin{document}\r\n\\input{sections/notes}\r\n"
                b"\\input{sections/conclusion}\r\n\\end{document}\r\n")
        part = ("\ufeffFirst 😀 paragraph.\r\n\r\nSecond paragraph.\r\n\r\n"
                "\\begin{verbatim}\r\npreserve this raw cell\r\n\\end{verbatim}\r\n").encode()
        assets = {"main.tex": main, "appendix.ltx": b"\\documentclass{article}\\begin{document}Other.\\end{document}",
                  "sections/notes.tex": part, "sections/conclusion.tex": b"Original conclusion.\r\n",
                  "media/figure.png": b"\x89PNG\x00\xff",
                  "notes.md": b"Sample command: \\documentclass{article}"}
        imported = self.service.import_files(ada, self.project, list(assets.items()))
        canonical = self.service.export_zip(ada, self.project)
        original_audit = self.service.audit(ada, self.project)
        self.assertEqual(self.service.preview_source(iris, self.project), (canonical, "main.tex", imported["revision"], 0))
        self.assertEqual(self.service.preview_source(iris, self.project, root="appendix.ltx"),
                         (canonical, "appendix.ltx", imported["revision"], 0))
        replacements = {"Second paragraph.": "This is a draft.", "First 😀 paragraph.": "A longer first paragraph 😀.",
                        "Original conclusion.": "New conclusion."}
        cells = {block["quote"]: block for block in imported["blocks"] if block["rich"]}
        drafts = [{"block_id": cells[quote]["stableId"], "base_block_revision": cells[quote]["revision"], "source": replacement}
                  for quote, replacement in replacements.items()]
        preview, root, revision, count = self.service.preview_source(bao, self.project, drafts=drafts)
        self.assertEqual((root, revision, count), ("main.tex", imported["revision"], len(drafts)))
        with zipfile.ZipFile(io.BytesIO(preview)) as archive:
            notes = part.replace("First 😀 paragraph.".encode(), "A longer first paragraph 😀.".encode())
            notes = notes.replace(b"Second paragraph.", b"This is a draft.")
            expected = assets | {"sections/notes.tex": notes, "sections/conclusion.tex": b"New conclusion.\r\n"}
            self.assertEqual({name: archive.read(name) for name in archive.namelist()}, expected)
        self.assertEqual(self.service.export_zip(ada, self.project), canonical)
        self.assertEqual(self.service.project(ada, self.project), imported)
        self.assertEqual(self.service.audit(ada, self.project), original_audit)

    def test_manuscript_preview_rejects_foreign_projects_invalid_roots_and_stale_drafts(self):
        ada, bao, iris = (self.actors[name] for name in ("ada", "bao", "iris"))
        outsider = self.service.create_actor(ada, "Outsider", "human")
        outsider = self.service.actor_by_token(outsider["token"])
        with self.assertRaises(ServiceError) as denied:
            self.service.preview_source(outsider, self.project)
        self.assertEqual(denied.exception.status, 403)
        for root in ("../main.tex", "estuary/sections/methods.tex"):
            with self.subTest(root=root):
                with self.assertRaises(ServiceError) as invalid:
                    self.service.preview_source(bao, self.project, root=root)
                self.assertEqual(invalid.exception.status, 400)
        empty = self.service.create_project(ada, "Empty")
        with self.assertRaises(ServiceError) as missing:
            self.service.preview_source(ada, empty["id"])
        self.assertEqual(missing.exception.status, 409)
        cell = paragraph(self.service, bao, self.project)
        draft = {"block_id": cell["stableId"], "base_block_revision": cell["revision"], "source": cell["quote"] + " Draft."}
        with self.assertRaises(ServiceError) as duplicate:
            self.service.preview_source(bao, self.project, drafts=[draft, draft])
        self.assertEqual(duplicate.exception.status, 400)
        with self.assertRaises(ServiceError) as review_only:
            self.service.preview_source(iris, self.project, drafts=[draft])
        self.assertEqual(review_only.exception.status, 403)
        assigned = self.service.assign_owner(ada, self.project, cell["stableId"], ada["id"])
        with self.assertRaises(ServiceError) as wrong_owner:
            self.service.preview_source(bao, self.project, drafts=[draft | {"base_block_revision": assigned["revision"]}])
        self.assertEqual(wrong_owner.exception.status, 403)
        with self.assertRaises(ServiceError) as stale:
            self.service.preview_source(ada, self.project, drafts=[draft])
        self.assertEqual(stale.exception.status, 409)

    def test_insert_cell_checks_the_neighbor_and_preserves_other_blocks(self):
        ada, bao, iris = (self.actors[name] for name in ("ada", "bao", "iris"))
        source = b"First.\r\n\r\n\\begin{verbatim}\r\nkeep\r\n\\end{verbatim}\r\n\r\nLast.\r\n"
        detail = self.service.import_files(ada, self.project, [("notes.tex", source)])
        first, raw, last = detail["blocks"]
        assignment = self.service.assign_owner(ada, self.project, first["stableId"], bao["id"])
        anchor = self.service.create_anchor(iris, self.project, first["stableId"])
        with self.assertRaises(ServiceError) as unauthorized:
            self.service.insert_cell(bao, self.project, first["stableId"], "before", "paragraph", "Draft.", assignment["revision"])
        self.assertEqual(unauthorized.exception.status, 403)
        with self.assertRaises(ServiceError) as stale:
            self.service.insert_cell(ada, self.project, first["stableId"], "before", "paragraph", "Draft.", first["revision"])
        self.assertEqual(stale.exception.status, 409)
        with self.assertRaises(ServiceError) as unsupported:
            self.service.insert_cell(ada, self.project, first["stableId"], "after", "paragraph", "One.\n\nTwo.", assignment["revision"])
        self.assertEqual(unsupported.exception.status, 409)
        self.assertEqual(self.service.file_text(ada, self.project, "notes.tex")["text"].encode(), source)
        added = self.service.insert_cell(ada, self.project, first["stableId"], "before", "paragraph", "First.", assignment["revision"])
        detail = self.service.project(ada, self.project)
        self.assertEqual([block["stableId"] for block in detail["blocks"]],
                         [added["stableId"], first["stableId"], raw["stableId"], last["stableId"]])
        self.assertEqual(detail["blocks"][1]["owner_id"], bao["id"])
        self.assertEqual(detail["blocks"][1]["revision"], assignment["revision"])
        self.assertEqual(detail["blocks"][2]["quote"], raw["quote"])
        self.assertEqual(detail["anchors"][0]["id"], anchor["id"])
        self.assertEqual(detail["anchors"][0]["status"], "exact")
        self.assertEqual(self.service.file_text(ada, self.project, "notes.tex")["text"].encode(), b"First.\r\n\r\n" + source)
        heading = self.service.insert_cell(ada, self.project, raw["stableId"], "after", "heading", r"\section{Analysis}", raw["revision"])
        self.assertEqual(heading["path"], "notes.tex")
        self.assertIn("\\end{verbatim}\r\n\r\n\\section{Analysis}\r\n\r\nLast.", self.service.file_text(ada, self.project, "notes.tex")["text"])

    def test_membership_changes_preserve_a_human_lead_and_clear_ownership(self):
        ada, bao, iris, quill = (self.actors[name] for name in ("ada", "bao", "iris", "quill"))
        with self.assertRaises(ServiceError):
            self.service.add_member(ada, self.project, quill["id"], "lead")
        with self.assertRaises(ServiceError):
            self.service.add_member(ada, self.project, ada["id"], "author")
        with self.assertRaises(ServiceError):
            self.service.remove_member(ada, self.project, ada["id"])
        original = paragraph(self.service, bao, self.project)
        scope = self.service.assign_owner(ada, self.project, original["stableId"], bao["id"])
        suggestion = self.service.propose(bao, self.project, original["stableId"], scope["revision"],
                                          original["quote"], original["quote"] + " Pending.", "source")
        self.service.add_member(ada, self.project, bao["id"], "reviewer")
        detail = self.service.project(ada, self.project)
        block = paragraph(self.service, ada, self.project)
        self.assertIsNone(block["owner_id"])
        self.assertGreater(block["revision"], scope["revision"])
        self.assertEqual(detail["suggestions"][0]["status"], "revoked")
        with self.assertRaises(ServiceError):
            self.service.accept(iris, self.project, suggestion["id"])
        self.service.add_member(ada, self.project, bao["id"], "lead")
        self.service.remove_member(bao, self.project, ada["id"])
        self.assertEqual(self.service.projects(bao)[0]["role"], "lead")

    def test_restore_upgrades_legacy_block_revisions_and_pending_suggestions(self):
        ada, bao, iris = (self.actors[name] for name in ("ada", "bao", "iris"))
        block = paragraph(self.service, bao, self.project)
        scope = self.service.assign_owner(ada, self.project, block["stableId"], bao["id"])
        proposal = self.service.propose(bao, self.project, block["stableId"], scope["revision"],
                                        block["quote"], block["quote"] + " Legacy edit.", "source")
        legacy = Path(self.tmp.name) / "legacy.sqlite"
        legacy.write_bytes(self.service.backup(ada))
        with sqlite3.connect(legacy) as connection:
            connection.execute("ALTER TABLE suggestions DROP COLUMN base_block_revision")
            connection.execute("ALTER TABLE blocks DROP COLUMN allow_ai")
            connection.execute("ALTER TABLE blocks DROP COLUMN revision")
        self.service.restore(ada, legacy.read_bytes())
        restored = paragraph(self.service, bao, self.project)
        self.assertEqual(restored["owner_id"], bao["id"])
        self.assertEqual(restored["revision"], scope["revision"])
        self.assertFalse(restored["allow_ai"])
        accepted = self.service.accept(iris, self.project, proposal["id"])
        self.assertEqual(accepted["base_block_revision"], scope["revision"])
        self.assertEqual(accepted["status"], "accepted")

    def test_block_comment_creates_anchor_and_comment_together(self):
        iris = self.actors["iris"]
        block = paragraph(self.service, iris, self.project)
        with self.assertRaises(ServiceError):
            self.service.comment_on_block(iris, self.project, block["stableId"], " ")
        self.assertEqual(self.service.project(iris, self.project)["anchors"], [])
        comment = self.service.comment_on_block(iris, self.project, block["stableId"], " Check the reference. ")
        detail = self.service.project(iris, self.project)
        self.assertEqual(detail["anchors"][0]["id"], comment["anchor_id"])
        self.assertEqual(detail["anchors"][0]["status"], "exact")
        self.assertEqual(detail["comments"][0]["body"], "Check the reference.")

    def test_a_split_stays_for_review_and_a_move_keeps_the_anchor(self):
        block = paragraph(self.service, self.actors["ada"], self.project)
        detail = self.service.project(self.actors["ada"], self.project)
        anchor = self.service.create_anchor(self.actors["iris"], self.project, block["stableId"])
        suggestion = self.service.propose(self.actors["bao"], self.project, block["stableId"], detail["revision"],
                                          block["quote"], "First sentence.\n\nSecond sentence.", "source")
        with self.assertRaises(ServiceError):
            self.service.accept(self.actors["iris"], self.project, suggestion["id"])
        self.assertEqual(self.service.project(self.actors["ada"], self.project)["revision"], detail["revision"])
        text = self.service.file_text(self.actors["ada"], self.project, block["path"])["text"]
        moved = self.service.move_block(self.actors["ada"], self.project, block["stableId"], len(text))
        self.assertEqual(moved["stableId"], block["stableId"])
        anchors = self.service.project(self.actors["ada"], self.project)["anchors"]
        self.assertEqual(next(item for item in anchors if item["id"] == anchor["id"])["status"], "exact")

    def test_release_is_immutable_and_blocked_by_unresolved_review(self):
        block = paragraph(self.service, self.actors["ada"], self.project)
        anchor = self.service.create_anchor(self.actors["iris"], self.project, block["stableId"])
        detail = self.service.project(self.actors["ada"], self.project)
        suggestion = self.service.propose(self.actors["bao"], self.project, block["stableId"], detail["revision"],
                                          block["quote"], block["quote"].replace("two readings", "checked readings"), "visual")
        self.service.accept(self.actors["iris"], self.project, suggestion["id"])
        with self.assertRaises(ServiceError):
            self.service.release(self.actors["ada"], self.project)
        self.service.dismiss_anchor(self.actors["ada"], self.project, anchor["id"])
        released = self.service.release(self.actors["ada"], self.project)
        blob, manifest = self.service.release_zip(self.actors["bao"], self.project, released["id"])
        self.assertIn("checked readings", text_of(blob, "estuary/sections/methods.tex"))
        self.assertEqual(manifest["revision"], released["revision"])
        heading = next(item for item in self.service.project(self.actors["ada"], self.project)["blocks"] if item["kind"] == "heading")
        later = self.service.propose(self.actors["ada"], self.project, heading["stableId"],
                                     self.service.project(self.actors["ada"], self.project)["revision"],
                                     heading["quote"], heading["quote"].replace("Sampling", "Final"), "source")
        self.service.accept(self.actors["iris"], self.project, later["id"])
        again, _manifest = self.service.release_zip(self.actors["ada"], self.project, released["id"])
        self.assertEqual(blob, again)
        self.assertIn("Final", text_of(self.service.export_zip(self.actors["ada"], self.project), "estuary/sections/methods.tex"))

    def test_roles_evidence_ai_and_recovery(self):
        reader = self.service.create_actor(self.actors["ada"], "Ren", "human")
        self.service.add_member(self.actors["ada"], self.project, reader["id"], "reader")
        block = paragraph(self.service, self.actors["ada"], self.project)
        detail = self.service.project(self.actors["ada"], self.project)
        ren = {"id": reader["id"], "name": "Ren", "kind": "human", "workspace_role": "", "revoked": False}
        with self.assertRaises(ServiceError):
            self.service.propose(ren, self.project, block["stableId"], detail["revision"], block["quote"], block["quote"] + " No.", "source")
        with self.assertRaises(ServiceError):
            self.service.release(self.actors["bao"], self.project)
        self.service.assign_owner(self.actors["ada"], self.project, block["stableId"], self.actors["bao"]["id"])
        with self.assertRaises(ServiceError):
            self.service.release(self.actors["bao"], self.project)
        evidence = next(item for item in detail["objects"] if item["external"].get("identifier") == "fieldguide")
        claim = self.service.add_object(self.actors["ada"], self.project, "claim", "Salinity differs by station", "The table shows the gap.")
        link = self.service.link_claim(self.actors["ada"], self.project, claim["id"], evidence["id"])
        self.service.update_object(self.actors["ada"], self.project, evidence["id"], evidence["body"] + "\n% revised")
        linked = next(item for item in self.service.project(self.actors["ada"], self.project)["links"] if item["id"] == link["id"])
        self.assertTrue(linked["changed"])
        self.assertEqual(linked["evidence_revision"], link["evidence_revision"])
        collection = self.service.create_collection(self.actors["ada"], "Active papers", [self.project])
        self.assertEqual(collection["projects"], [self.project])
        found = self.service.search(self.actors["bao"], "Estuary sampling")
        self.assertTrue(any(item["id"] == evidence["id"] for item in found))
        external = self.service.add_object(self.actors["ada"], self.project, "dataset", "Station log", "",
                                           {"system": "zenodo", "identifier": "10.0/example", "version": "1", "access": "public", "holding": "reference"})
        self.assertEqual(external["external"]["holding"], "reference")
        proposal = self.service.mcp(self.actors["quill"], "propose", {"project": self.project, "block": block["stableId"],
                                    "base_revision": self.service.project(self.actors["ada"], self.project)["revision"],
                                    "before": self.service.project(self.actors["ada"], self.project)["blocks"] and
                                    next(item["quote"] for item in self.service.project(self.actors["ada"], self.project)["blocks"] if item["stableId"] == block["stableId"]),
                                    "after": block["quote"].replace("two readings", "model readings"), "mode": "source"})
        self.assertEqual(proposal["actor_kind"], "assistant")
        with self.assertRaises(ServiceError):
            self.service.accept(self.actors["quill"], self.project, proposal["id"])
        self.service.revoke_actor(self.actors["ada"], self.actors["quill"]["id"])
        suggestions = self.service.project(self.actors["ada"], self.project)["suggestions"]
        self.assertEqual(next(item for item in suggestions if item["id"] == proposal["id"])["status"], "revoked")
        quill = self.service.actor_by_token("demo-quill")
        self.assertTrue(quill["revoked"])
        with self.assertRaises(ServiceError):
            self.service.propose(quill, self.project, block["stableId"], 1, "a", "b", "source")
        self.service.remove_member(self.actors["ada"], self.project, self.actors["bao"]["id"])
        with self.assertRaises(ServiceError):
            self.service.project(self.actors["bao"], self.project)
        backup = self.service.backup(self.actors["ada"])
        self.service.set_policy(self.actors["ada"], False, 1)
        self.assertFalse(self.service.policy()["allow_ai"])
        self.service.restore(self.actors["ada"], backup)
        self.assertTrue(self.service.policy()["allow_ai"])
        self.service.set_policy(self.actors["ada"], True, 30)
        old = self.service.create_project(self.actors["ada"], "Old draft")
        self.service.db.execute("UPDATE projects SET updated_at = ? WHERE id = ?", (self.service.now() - 40 * 86400, old["id"]))
        self.service.db.commit()
        purged = self.service.purge(self.actors["ada"])
        self.assertIn(old["id"], purged["removed"])
        self.assertEqual(self.service.project(self.actors["ada"], self.project)["title"], "Estuary field notes")

    def test_http_uses_the_same_rules(self):
        api = Api(self.service)
        status, me = api.handle("GET", "/api/me", {"authorization": "Bearer demo-bao"}, b"")
        self.assertEqual(status, 200)
        self.assertEqual(me["name"], "Bao")
        status, denied = api.handle("POST", f"/api/projects/{self.project}/release", {"authorization": "Bearer demo-bao", "content-type": "application/json"}, b"{}")
        self.assertEqual(status, 403)
        self.assertIn("role", denied["error"])
        status, page = api.handle("GET", "/", {}, b"")
        self.assertEqual(status, 200)
        self.assertTrue(page["file"].endswith("project.html"))


def text_of(blob, name):
    with zipfile.ZipFile(io.BytesIO(blob)) as archive:
        return archive.read(name).decode()


if __name__ == "__main__":
    unittest.main()
