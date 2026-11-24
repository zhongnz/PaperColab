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

    def test_delegated_task_capability_and_review(self):
        s,p,a=self.service,self.project,self.actors
        api=Api(s)
        block=paragraph(s,a["bao"],p)
        evidence=s.add_object(a["ada"],p,"note","Allowed context","Evidence for three readings.")
        private=s.add_object(a["ada"],p,"note","Unassigned context","Not in the task.")
        original=s.file_text(a["ada"],p,block["path"])
        def request(method,path,token,data=None):
            return api.handle(method,path,{"authorization":"Bearer "+token,"content-type":"application/json"},
                              b"" if data is None else json.dumps(data).encode())
        task_route="/api/projects/"+p+"/agent-tasks"
        payload={"block_id":block["stableId"],"assignee_id":a["quill"]["id"],
                 "instructions":"Revise the sample description using the supplied context.","context_ids":[evidence["id"]]}
        self.assertEqual(request("POST",task_route,"demo-bao",payload)[0],403)
        code,created=request("POST",task_route,"demo-ada",payload)
        self.assertEqual(code,200,created)
        secret=created["token"]; task=created["task"]; endpoint="/api/delegated/"+task["id"]
        self.assertNotIn(secret,json.dumps(s.project(a["ada"],p)))
        self.assertNotIn(secret,json.dumps(s.audit(a["ada"],p)))
        self.assertNotEqual(s._task_row(task["id"])["token_hash"],secret)
        self.assertEqual(request("GET","/api/projects",secret)[0],401)
        self.assertEqual(request("GET","/api/projects/"+p,secret)[0],401)
        self.assertEqual(request("GET",endpoint+"/context","demo-quill")[0],401)
        code,context=request("GET",endpoint+"/context",secret)
        self.assertEqual(code,200,context)
        self.assertEqual(context["cell"]["id"],block["stableId"])
        self.assertEqual([o["id"] for o in context["context"]],[evidence["id"]])
        self.assertNotIn(private["body"],json.dumps(context))
        proposal={"after":block["quote"].replace("two readings","three readings"),
                  "rationale":"Align the manuscript with the assigned note.","evidence_ids":[evidence["id"]]}
        self.assertEqual(request("POST",endpoint+"/proposal",secret,{**proposal,"block_id":"other"})[0],400)
        self.assertEqual(request("POST",endpoint+"/proposal",secret,{**proposal,"evidence_ids":[private["id"]]})[0],403)
        self.assertEqual(request("POST",endpoint+"/proposal",secret,{**proposal,"after":proposal["after"]+"\n\nExtra."})[0],409)
        code,result=request("POST",endpoint+"/proposal",secret,proposal)
        self.assertEqual(code,200,result)
        suggestion=result["suggestion"]
        self.assertEqual(suggestion["status"],"pending")
        self.assertEqual(suggestion["actor_id"],a["quill"]["id"])
        self.assertEqual(s.file_text(a["ada"],p,block["path"]),original)
        self.assertEqual(request("POST",endpoint+"/proposal",secret,proposal)[0],409)
        self.assertEqual(request("GET",endpoint+"/context",secret)[0],409)
        self.assertEqual(request("POST","/api/projects/"+p+"/suggestions/"+suggestion["id"]+"/accept",secret,{})[0],401)
        s.accept(a["iris"],p,suggestion["id"])
        self.assertIn("three readings",s.file_text(a["ada"],p,block["path"])["text"])
        self.assertEqual(s._task_view(s._task_row(task["id"]))["status"],"accepted")

    def test_delegated_task_context_changes_expiry_and_revocation(self):
        s,p,a=self.service,self.project,self.actors
        block=paragraph(s,a["bao"],p)
        evidence=s.add_object(a["ada"],p,"note","Context","Original")
        def create():
            return s.create_agent_task(a["ada"],p,block["stableId"],a["quill"]["id"],"Revise the cell",[evidence["id"]])
        def submit(created):
            return s.delegated_proposal(created["task"]["id"],created["token"],
                block["quote"].replace("two readings","three readings"),"Reason",[evidence["id"]])
        first=create()
        submitted=submit(first)["suggestion"]
        s.update_object(a["ada"],p,evidence["id"],"Changed context")
        with self.assertRaises(ServiceError) as err:
            s.accept(a["iris"],p,submitted["id"])
        self.assertEqual(err.exception.status,409)
        self.assertEqual(s._suggestion(submitted["id"])["status"],"stale")
        second=create()
        s.cancel_agent_task(a["ada"],p,second["task"]["id"])
        with self.assertRaises(ServiceError):
            s.delegated_context(second["task"]["id"],second["token"])
        third=create()
        s.clock=lambda:third["task"]["expires_at"]+1
        with self.assertRaises(ServiceError) as err:
            submit(third)
        self.assertEqual(err.exception.status,409)
        fourth=create()
        s.set_policy(a["ada"],False,0)
        with self.assertRaises(ServiceError) as err:
            s.delegated_context(fourth["task"]["id"],fourth["token"])
        self.assertEqual(err.exception.status,403)
        s.set_policy(a["ada"],True,0)
        s.remove_member(a["ada"],p,a["quill"]["id"])
        with self.assertRaises(ServiceError) as err:
            submit(fourth)
        self.assertEqual(err.exception.status,401)
        s.add_member(a["ada"],p,a["quill"]["id"],"author")
        with self.assertRaises(ServiceError) as err:
            submit(fourth)
        self.assertEqual(err.exception.status,401)
        self.assertEqual(paragraph(s,a["bao"],p)["quote"],block["quote"])

    def test_research_workflow_dependencies_evaluation_and_retry(self):
        s,p,a=self.service,self.project,self.actors
        cell=paragraph(s,a["bao"],p)
        note=s.add_object(a["ada"],p,"note","Workflow evidence","Three readings.")
        w=s.create_workflow(a["ada"],p,"Methods revision","Review evidence before updating methods.")
        def data(title,deps):
            return {"title":title,"block_id":cell["stableId"],"assignee_id":a["quill"]["id"],
                    "instructions":"Use the supplied evidence.","criteria":"No invented observations.",
                    "context_ids":[note["id"]],"dependencies":deps}
        def add(title,deps):
            return s.add_workflow_step(a["ada"],p,w["id"],data(title,deps))
        def view():
            return next(x for x in s.project(a["ada"],p)["workflows"] if x["id"]==w["id"])
        first=add("Review evidence",[])["steps"][0]
        second=add("Refine methods",[first["id"]])["steps"][1]
        with self.assertRaises(ServiceError) as err:
            add("Invalid dependency",["foreign-id"])
        self.assertEqual(err.exception.status,400)
        self.assertEqual([x["status"] for x in view()["steps"]],["ready","blocked"])
        def launch(step,who="ada"):
            return s.launch_workflow_step(a[who],p,w["id"],step["id"])
        for step,who,code in [(second,"ada",409),(first,"quill",403),(first,"bao",403)]:
            with self.assertRaises(ServiceError) as err:
                launch(step,who)
            self.assertEqual(err.exception.status,code)
        created=launch(first)
        with self.assertRaises(ServiceError):
            launch(first)
        self.assertIn("Acceptance criteria:",s.delegated_context(created["task"]["id"],created["token"])["instructions"])
        def submit(task,old,new):
            ctx=s.delegated_context(task["task"]["id"],task["token"])
            return s.delegated_proposal(task["task"]["id"],task["token"],
                ctx["cell"]["source"].replace(old,new),"Use evidence.",[note["id"]])["suggestion"]
        suggestion=submit(created,"two readings","three readings")
        self.assertEqual(view()["steps"][0]["status"],"review")
        s.accept(a["iris"],p,suggestion["id"])
        self.assertEqual([x["status"] for x in view()["steps"]],["evaluation","blocked"])
        attempt=view()["steps"][0]["attempts"][-1]
        def evaluate(step,attempt,outcome,who="iris"):
            return s.evaluate_workflow_step(a[who],p,w["id"],step["id"],attempt["id"],outcome,"Checked criteria.")
        with self.assertRaises(ServiceError):
            evaluate(first,attempt,"pass","quill")
        evaluate(first,attempt,"pass")
        self.assertEqual([x["status"] for x in view()["steps"]],["completed","ready"])
        with self.assertRaises(ServiceError):
            evaluate(first,attempt,"pass")
        task=launch(second)
        self.assertIn("three readings",s.delegated_context(task["task"]["id"],task["token"])["cell"]["source"])
        s.cancel_agent_task(a["ada"],p,task["task"]["id"])
        self.assertEqual(view()["steps"][1]["status"],"retry")
        task=launch(second)
        suggestion=submit(task,"three readings","four readings")
        s.accept(a["iris"],p,suggestion["id"])
        attempt=view()["steps"][1]["attempts"][-1]
        evaluate(second,attempt,"revise")
        self.assertEqual(view()["steps"][1]["status"],"retry")
        task=launch(second)
        suggestion=submit(task,"four readings","five readings")
        s.accept(a["iris"],p,suggestion["id"])
        attempt=view()["steps"][1]["attempts"][-1]
        evaluate(second,attempt,"pass")
        self.assertEqual(view()["completed"],2)
        self.assertEqual(len(view()["steps"][1]["attempts"]),3)
        self.assertNotIn(task["token"],json.dumps(view()))
        self.assertEqual(s.project(a["quill"],p)["workflows"],[])
        path=s.path
        s.close()
        self.service=Service(path)
        self.assertEqual(self.service.project(a["ada"],p)["workflows"][0]["completed"],2)

    def test_experiment_pinned_inputs_reviewed_evidence(self):
        from compute.contract import validate_bundle
        import hashlib
        s,p,a=self.service,self.project,self.actors
        code=s.add_object(a["ada"],p,"code","Analysis","print(42)")
        data=s.add_object(a["ada"],p,"dataset","Readings","1,2,3")
        args={"title":"Fixture analysis","objective":"Check the computation.","language":"python",
              "image":"sha256:"+"a"*64,"code_id":code["id"],"dataset_ids":[data["id"]]}
        with self.assertRaises(ServiceError):
            s.create_experiment(a["quill"],p,args)
        with self.assertRaises(ServiceError):
            s.create_experiment(a["ada"],p,{**args,"image":"python:latest"})
        run=s.create_experiment(a["bao"],p,args)
        key=run["id"]; bundle=s.experiment_bundle(a["bao"],p,key)
        self.assertEqual(validate_bundle(bundle)["datasets"][0]["body"],"1,2,3")
        s.update_object(a["ada"],p,data["id"],"4,5,6")
        self.assertEqual(s.experiment_bundle(a["bao"],p,key),bundle)
        log="42\n"
        receipt={"format":"papercolab-receipt-v1","experiment_id":key,"bundle_sha256":bundle["sha256"],
                 "image":args["image"],"runner":"docker-local-v1","status":"succeeded","exit_code":0,
                 "elapsed_ms":10,"log":log,"log_sha256":hashlib.sha256(log.encode()).hexdigest()}
        for invalid in ({**receipt,"bundle_sha256":"b"*64},{**receipt,"log":"tampered"}):
            with self.assertRaises(ServiceError):
                s.submit_experiment(a["bao"],p,key,invalid)
        with self.assertRaises(ServiceError):
            s.submit_experiment(a["quill"],p,key,receipt)
        with self.assertRaises(ServiceError):
            s.review_experiment(a["iris"],p,key,"accepted","No receipt yet.")
        self.assertEqual(s.submit_experiment(a["bao"],p,key,receipt)["status"],"review")
        with self.assertRaises(ServiceError):
            s.submit_experiment(a["bao"],p,key,receipt)
        with self.assertRaises(ServiceError):
            s.review_experiment(a["bao"],p,key,"accepted","Not a reviewer.")
        reviewed=s.review_experiment(a["iris"],p,key,"accepted","Fixture checked.")
        evidence=s._row_object(reviewed["evidence_id"])
        self.assertEqual(evidence["kind"],"run")
        self.assertEqual(json.loads(evidence["body"])["bundle"],bundle)
        with self.assertRaises(ServiceError):
            s.update_object(a["ada"],p,evidence["id"],"Modified")
        claim=s.add_object(a["ada"],p,"claim","Result","The result was 42.")
        link=s.link_claim(a["bao"],p,claim["id"],evidence["id"])
        self.assertEqual(link["evidence_revision"],1)
        self.assertEqual(s.project(a["quill"],p)["experiments"],[])
        path=s.path;s.close();self.service=Service(path)
        self.assertEqual(self.service.project(a["ada"],p)["experiments"][0]["status"],"accepted")

    def test_structured_outputs_review_and_cell_provenance(self):
        import hashlib
        from compute.contract import digest, OUTPUT_PREFIX
        s,p,a=self.service,self.project,self.actors
        code=s.add_object(a["ada"],p,"code","Output code","print(1)")
        run=s.create_experiment(a["ada"],p,{"title":"Structured run","objective":"Test output links",
            "language":"python","image":"sha256:"+"a"*64,"code_id":code["id"],"dataset_ids":[]})
        bundle=s.experiment_bundle(a["ada"],p,run["id"])
        output={"name":"results","kind":"table","title":"Results","columns":["n"],"rows":[[1]]}
        log=OUTPUT_PREFIX+json.dumps(output)+"\n"
        receipt={"format":"papercolab-receipt-v2","experiment_id":run["id"],"bundle_sha256":bundle["sha256"],
            "image":bundle["spec"]["image"],"runner":"docker-local-v1","status":"succeeded","exit_code":0,
            "elapsed_ms":10,"log":log,"log_sha256":hashlib.sha256(log.encode()).hexdigest(),"outputs":[output]}
        block=paragraph(s,a["bao"],p)
        def link(actor="bao",version=block["version"]):
            return s.link_experiment_output(a[actor],p,run["id"],"results",block["stableId"],version)
        with self.assertRaises(ServiceError):
            link()
        with self.assertRaises(ServiceError):
            s.submit_experiment(a["bao"],p,run["id"],{**receipt,"outputs":[{**output,"rows":[[2]]}]})
        s.submit_experiment(a["bao"],p,run["id"],receipt)
        with self.assertRaises(ServiceError):
            link()
        s.review_experiment(a["iris"],p,run["id"],"accepted","Fixture reviewed.")
        with self.assertRaises(ServiceError):
            link("quill")
        result=link()
        self.assertEqual(result["output_sha256"],digest(output))
        self.assertEqual(result["status"],"exact")
        released=s.release(a["ada"],p)
        _,manifest=s.release_zip(a["bao"],p,released["id"])
        self.assertEqual(manifest["experiment_output_links"][0]["output_sha256"],digest(output))
        self.assertEqual(manifest["experiment_output_links"][0]["status"],"exact")
        with self.assertRaises(ServiceError):
            link()
        s.direct_edit(a["bao"],p,block["stableId"],block["version"],block["quote"],
                      block["quote"].replace("two readings","three readings"),"source")
        self.assertEqual(s.project(a["ada"],p)["experiment_output_links"][0]["status"],"changed")
        with self.assertRaises(ServiceError):
            link()
        self.assertEqual(link(version=block["version"]+1)["status"],"exact")
        self.assertEqual(s.project(a["quill"],p)["experiment_output_links"],[])
        self.assertEqual(s.release_zip(a["bao"],p,released["id"])[1],manifest)

    def test_credential_hash_migration_rotation_and_authority(self):
        import sqlite3
        from server.service import token_digest
        s,p,a=self.service,self.project,self.actors
        account=s.create_actor(a["ada"],"Credential fixture","human")
        key,secret=account["id"],account["token"]
        stored=s.db.execute("SELECT token FROM actors WHERE id=?",(key,)).fetchone()[0]
        self.assertEqual(stored,token_digest(secret))
        with self.assertRaises(ServiceError):
            s.actor_by_token(stored)
        s.add_member(a["ada"],p,key,"author")
        s.db.execute("UPDATE actors SET token=? WHERE id=?",(secret,key))
        s.db.commit()
        path=s.path
        s.close();self.service=Service(path)
        s=self.service
        self.assertEqual(s.actor_by_token(secret)["id"],key)
        self.assertEqual(s.db.execute("SELECT token FROM actors WHERE id=?",(key,)).fetchone()[0],stored)
        rotated=s.rotate_actor(a["ada"],key)
        with self.assertRaises(ServiceError):
            s.actor_by_token(secret)
        self.assertEqual(s.actor_by_token(rotated["token"])["id"],key)
        self.assertNotIn(rotated["token"],json.dumps(s.list_accounts(a["ada"])))
        with self.assertRaises(ServiceError):
            s.rotate_actor(a["bao"],key)
        with self.assertRaises(ServiceError):
            s.remove_member(a["ada"],p,a["ada"]["id"])
        with self.assertRaises(ServiceError):
            s.add_member(a["ada"],p,a["ada"]["id"],"reader")
        with self.assertRaises(ServiceError):
            s.add_member(a["ada"],p,a["quill"]["id"],"lead")
        with self.assertRaises(ServiceError):
            s.import_example(a["quill"],p)
        with self.assertRaises(ServiceError):
            s.import_example(a["ada"],p)
        s.revoke_actor(a["ada"],key)
        self.assertTrue(s.actor_by_token(rotated["token"])["revoked"])
        code,_=Api(s).handle("GET","/api/me",{"authorization":"Bearer "+rotated["token"]},b"")
        self.assertEqual(code,403)

    def test_non_demo_restore_cannot_resurrect_credentials(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as tmp:
            s=Service(Path(tmp)/"private.sqlite")
            try:
                operator_id=s._insert_actor("Operator","human","test-operator-credential","operator")
                s.db.commit()
                operator=s.actor_by_token("test-operator-credential")
                account=s.create_actor(operator,"Collaborator","human")
                project=s.create_project(operator,"Private")
                s.add_member(operator,project["id"],account["id"],"author")
                backup=s.backup(operator)
                s.set_policy(operator,False,0)
                self.assertTrue(s.restore(operator,backup)["restored"])
                self.assertTrue(s.policy()["allow_ai"])
                rotated=s.rotate_actor(operator,account["id"])
                with self.assertRaises(ServiceError) as err:
                    s.restore(operator,backup)
                self.assertEqual(err.exception.status,409)
                self.assertEqual(s.actor_by_token(rotated["token"])["id"],account["id"])
                with self.assertRaises(ServiceError):
                    s.actor_by_token(account["token"])
                backup=s.backup(operator)
                s.remove_member(operator,project["id"],account["id"])
                with self.assertRaises(ServiceError):
                    s.restore(operator,backup)
                self.assertEqual(s.projects(s.actor_by_token(rotated["token"])),[])
            finally:
                s.close()

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
