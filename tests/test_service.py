import io
import json
from pathlib import Path
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

    def test_direct_cell_edits_version_conflicts_owner_and_reconnect(self):
        s, p, a = self.service, self.project, self.actors
        block = paragraph(s, a["bao"], p)
        heading = next(b for b in s.project(a["ada"], p)["blocks"] if b["kind"] == "heading")
        s.assign_owner(a["ada"], p, block["stableId"], a["bao"]["id"])
        changed = block["quote"].replace("two readings", "four readings")
        result = s.direct_edit(a["bao"], p, block["stableId"], block["version"], block["quote"], changed, "visual")
        self.assertEqual(result["block"]["version"], block["version"] + 1)
        self.assertEqual(result["block"]["owner_id"], a["bao"]["id"])
        for who in ("bao", "quill", "iris"):
            with self.assertRaises(ServiceError) as caught:
                s.direct_edit(a[who], p, block["stableId"], block["version"], block["quote"], changed, "source")
            self.assertEqual(caught.exception.status, 409 if who == "bao" else 403)
        s.direct_edit(a["ada"], p, heading["stableId"], heading["version"], heading["quote"],
                      heading["quote"].replace("Sampling method", "New method"), "source")
        newer = result["block"]
        s.direct_edit(a["bao"], p, newer["stableId"], newer["version"], newer["quote"], block["quote"], "source")
        with self.assertRaises(ServiceError) as caught:
            s.direct_edit(a["bao"], p, block["stableId"], block["version"], block["quote"], changed, "source")
        self.assertEqual(caught.exception.status, 409)
        path = s.path
        s.close()
        self.service = Service(path)
        now = paragraph(self.service, a["bao"], p)
        self.assertEqual(now["stableId"], block["stableId"])
        self.assertEqual(now["version"], block["version"] + 2)
        self.assertEqual(now["owner_id"], a["bao"]["id"])

    def test_structural_transactions_preserve_identity_and_governance(self):
        s,p,a=self.service,self.project,self.actors
        base=paragraph(s,a["bao"],p)
        path=base["path"]
        original=s.file_text(a["ada"],p,path)["text"]
        original_blocks=s._blocks(p,path)
        heading=next(b for b in original_blocks if b["kind"]=="heading")
        raw=next(b for b in original_blocks if b["kind"]=="raw")
        s.assign_owner(a["ada"],p,base["stableId"],a["bao"]["id"])
        def current(key):
            return next(b for b in s._blocks(p,path) if b["stableId"]==key)
        def run(key,action,options=None,actor="bao"):
            b=current(key)
            return s.structural_edit(a[actor],p,key,s.manuscript_revision(a["ada"],p)["revision"],
                                     b["version"],action,options)
        def denied(key,action,options=None,actor="bao",status=409):
            before=s.file_text(a["ada"],p,path)
            with self.assertRaises(ServiceError) as error:
                run(key,action,options,actor)
            self.assertEqual(error.exception.status,status)
            self.assertEqual(s.file_text(a["ada"],p,path),before)
        anchor=s.create_anchor(a["iris"],p,heading["stableId"])
        released=s.release(a["ada"],p)
        rev=s.manuscript_revision(a["ada"],p)["revision"]
        denied(base["stableId"],"insert",{"kind":"paragraph"},actor="quill",status=403)
        denied(base["stableId"],"insert",{"kind":"paragraph"},actor="iris",status=403)
        with self.assertRaises(ServiceError) as error:
            s.move_block(a["quill"],p,base["stableId"],0)
        self.assertEqual(error.exception.status,403)
        added=run(base["stableId"],"insert",{"kind":"paragraph"})["selectedId"]
        self.assertNotIn(added,[b["stableId"] for b in original_blocks])
        self.assertEqual(current(added)["quote"],"New paragraph.")
        self.assertEqual(current(raw["stableId"])["quote"],raw["quote"])
        self.assertEqual(current(base["stableId"])["owner_id"],a["bao"]["id"])
        with self.assertRaises(ServiceError) as error:
            s.structural_edit(a["bao"],p,base["stableId"],rev,base["version"],"insert",{"kind":"heading"})
        self.assertEqual(error.exception.status,409)
        run(added,"move-up")
        self.assertEqual(current(added)["version"],1)
        run(added,"move-down")
        run(added,"convert")
        self.assertEqual(current(added)["kind"],"heading")
        self.assertEqual(current(added)["version"],2)
        run(added,"convert")
        run(added,"delete")
        self.assertNotIn(added,[b["stableId"] for b in s._blocks(p,path)])
        denied(heading["stableId"],"delete")
        denied(base["stableId"],"delete")
        denied(raw["stableId"],"delete")
        # Moving an anchored cell preserves the same identity and quote.
        run(heading["stableId"],"move-down")
        self.assertEqual(next(x for x in s.project(a["ada"],p)["anchors"] if x["id"]==anchor["id"])["status"],"exact")
        run(heading["stableId"],"move-up")
        proposal=s.propose(a["quill"],p,base["stableId"],s.manuscript_revision(a["ada"],p)["revision"],
                           current(base["stableId"])["quote"],current(base["stableId"])["quote"]+" Extra.","source")
        split=run(base["stableId"],"split",{"offset":15})["selectedId"]
        self.assertEqual(current(split)["owner_id"],a["bao"]["id"])
        self.assertEqual(next(x for x in s.project(a["ada"],p)["suggestions"] if x["id"]==proposal["id"])["status"],"stale")
        denied(base["stableId"],"merge-next")
        s.assign_owner(a["ada"],p,split,None)
        run(base["stableId"],"merge-next")
        self.assertEqual(current(base["stableId"])["owner_id"],a["bao"]["id"])
        self.assertEqual(current(raw["stableId"])["quote"],raw["quote"])
        self.assertEqual(text_of(s.release_zip(a["ada"],p,released["id"])[0],path),original)
        self.assertTrue(any(x["action"]=="structure" for x in s.audit(a["ada"],p)))

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
