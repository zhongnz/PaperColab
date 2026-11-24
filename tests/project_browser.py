"""Exercise the workspace in Chromium: propose, accept, and see the review state."""
from http.server import ThreadingHTTPServer
import io
from pathlib import Path
import re
from shutil import which
import sys
from threading import Thread
import tempfile
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from playwright.sync_api import expect, sync_playwright

from server.http_app import Api
from server.service import Service
from server.__main__ import make_handler


def main():
    with tempfile.TemporaryDirectory() as tmp:
        service = Service(Path(tmp) / "paper.sqlite", demo=True)
        server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(Api(service)))
        Thread(target=server.serve_forever, daemon=True).start()
        port = server.server_address[1]
        with sync_playwright() as pw:
            browser = pw.chromium.launch(executable_path=which("google-chrome") or which("chromium"))
            for width in (1440, 390):
                exercise(browser, port, width)
            browser.close()
        server.shutdown()
        service.close()
    print("Workspace browser flow passed.")


def exercise(browser, port, width):
    page = browser.new_page(viewport={"width": width, "height": 900})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(f"http://127.0.0.1:{port}/")
    expect(page.get_by_role("heading", name=re.compile("Work on the project"))).to_be_visible()
    page.locator("#actor").select_option("demo-bao")
    expect(page.locator("#who")).to_contain_text("Bao")
    page.get_by_role("button", name=re.compile("Estuary field notes")).click()
    # The display excerpt is truncated and changes after repeated edits.
    # Identify the first paragraph by its semantic kind and persistent ID.
    outline = page.locator('#blocks button[data-kind="paragraph"]').first
    expect(outline).to_be_visible()
    stable_id = outline.get_attribute("data-stable-id")
    outline.click()
    prose = page.get_by_role("textbox", name="Visual block text")
    expect(prose).to_be_visible()
    if width == 1440:
        prose.click()
        prose.press("Control+Home")
        page.keyboard.insert_text("Checked ")
        page.get_by_role("button", name="Propose visual edit").click()
        expect(page.locator("#queue")).to_contain_text("Bao")
        expect(page.locator("#queue")).to_contain_text("visual · pending")
        page.locator("#actor").select_option("demo-iris")
        accept = page.get_by_role("button", name="Accept", exact=True)
        expect(accept).to_be_visible()
        accept.click()
        expect(page.locator("#queue")).to_contain_text("accepted")
        expect(page.get_by_role("textbox", name="Visual block text")).to_contain_text("Checked")
        with page.expect_download() as download:
            page.get_by_role("button", name="Download current ZIP").click()
        assert download.value.suggested_filename.endswith(".zip")
        encoded = page.evaluate("""async () => {
          const token = sessionStorage.getItem('papercolab-token');
          const id = document.getElementById('project-title').dataset.id;
          const response = await fetch('/api/projects/' + id + '/export', {headers: {authorization: 'Bearer ' + token}});
          const payload = await response.json();
          return payload.zip_b64;
        }""")
        import base64
        with zipfile.ZipFile(io.BytesIO(base64.b64decode(encoded))) as archive:
            assert "Checked " in archive.read("estuary/sections/methods.tex").decode()
        page.locator("#actor").select_option("demo-bao")
        expect(page.locator("#who")).to_contain_text("Bao")
        second = browser.new_page()
        second.goto(f"http://127.0.0.1:{port}/")
        second.get_by_role("button", name=re.compile("Estuary field notes")).click()
        second.locator(f'#blocks button[data-stable-id="{stable_id}"]').click()
        expect(second.get_by_role("textbox", name="Visual block text")).to_contain_text("Checked")
        prose.click()
        prose.press("Control+Home")
        page.keyboard.insert_text("Direct ")
        page.get_by_role("button", name="Save cell directly").click()
        second_prose=second.get_by_role("textbox", name="Visual block text")
        expect(second_prose).to_contain_text("Direct", timeout=12000)
        second_prose.click()
        second_prose.press("Control+Home")
        second.keyboard.insert_text("Local draft ")
        prose.click()
        prose.press("Control+Home")
        page.keyboard.insert_text("Remote ")
        page.get_by_role("button", name="Save cell directly").click()
        expect(second.locator("#sync-state")).to_contain_text("Your local draft is retained", timeout=12000)
        expect(second_prose).to_contain_text("Local draft")
        second.get_by_role("button", name="Save cell directly").click()
        expect(second.locator("#error")).to_contain_text("This cell changed remotely")
        expect(second_prose).to_contain_text("Local draft")
        second.get_by_role("button", name="Discard local draft").click()
        expect(second_prose).to_contain_text("Remote")
        expect(second_prose).not_to_contain_text("Local draft")
        second.close()
        page.get_by_role("button", name="Cells", exact=True).click()
        cells=page.locator("#hosted-cells")
        heading=cells.locator(".cell-heading").first
        paragraph=cells.locator(f'[data-stable-id="{stable_id}"]')
        expect(heading.locator(".visual-prose")).to_contain_text("Sampling method")
        heading.locator(".visual-prose").click()
        heading.locator(".visual-prose").press("Control+Home")
        page.keyboard.insert_text("Revised ")
        paragraph.locator(".visual-prose").click()
        paragraph.locator(".visual-prose").press("Control+Home")
        page.keyboard.insert_text("Independent ")
        expect(page.locator("#hosted-draft-count")).to_have_text("2 unsaved cells")
        heading.get_by_role("button", name="Save cell", exact=True).click()
        expect(page.locator("#hosted-draft-count")).to_have_text("1 unsaved cell")
        expect(paragraph.locator(".visual-prose")).to_contain_text("Independent")
        paragraph.get_by_role("button", name="Save cell", exact=True).click()
        expect(page.locator("#hosted-draft-count")).to_have_text("0 unsaved cells")
        document_button=page.get_by_role("button", name="Document", exact=True)
        document_button.click()
        expect(document_button).to_have_attribute("aria-pressed","true")
        expect(document_button).to_be_enabled()
        expect(heading.locator(".visual-prose")).to_contain_text("Revised")
        expect(paragraph.locator(".visual-prose")).to_contain_text("Independent")
        table=cells.locator(".scientific-panel").filter(has=page.locator("table")).first
        expect(table.get_by_role("textbox",name="Row 2, column 2",exact=True)).to_have_value("4")
        table.get_by_role("textbox",name="Row 2, column 2",exact=True).fill("8")
        table_cell=cells.locator(".manuscript-cell").filter(has=page.locator(".scientific-panel table")).first
        expect(page.locator("#hosted-draft-count")).to_have_text("1 unsaved cell")
        expect(table_cell.get_by_role("button",name="Save cell",exact=True)).to_be_enabled()
        table_cell.get_by_role("button",name="Save cell",exact=True).click()
        expect(page.locator("#hosted-draft-count")).to_have_text("0 unsaved cells")
        expect(table.get_by_role("textbox",name="Row 2, column 2",exact=True)).to_have_value("8")
        cell_button=page.get_by_role("button", name="Cells", exact=True)
        cell_button.click()
        expect(cell_button).to_have_attribute("aria-pressed","true")
        expect(cell_button).to_be_enabled()
        page.on("dialog",lambda dialog:dialog.accept())
        paragraph.get_by_role("button",name="Add paragraph",exact=True).click()
        expect(page.locator("#status")).to_contain_text("Cell structure updated")
        added=cells.locator(".manuscript-cell").filter(has=page.locator(".visual-prose").filter(has_text="New paragraph."))
        expect(added).to_have_count(1)
        new_id=added.get_attribute("data-stable-id")
        added=cells.locator(f'[data-stable-id="{new_id}"]')
        added.get_by_role("button",name="Make heading",exact=True).click()
        expect(added).to_have_class(re.compile("cell-heading"))
        added.get_by_role("button",name="Make paragraph",exact=True).click()
        expect(added).to_have_class(re.compile("cell-paragraph"))
        added.get_by_role("button",name="Delete cell",exact=True).click()
        expect(added).to_have_count(0)
        expect(paragraph.locator(".visual-prose")).to_contain_text("Independent")
        page.get_by_role("button", name="Focused", exact=True).click()
        expect(page.locator("#focused-cell")).to_be_visible()
        expect(page.get_by_role("button",name="Focused",exact=True)).to_be_enabled()
        page.locator("#actor").select_option("demo-ada")
        expect(page.locator("#who")).to_contain_text("Ada")
        expect(page.locator("#delegate-form")).to_be_visible()
        expect(page.locator("#create-agent-task")).to_be_enabled()
        page.locator("#delegate-cell").select_option(stable_id)
        page.locator("#delegate-assistant").select_option(label="Quill")
        context_ids=page.locator("#delegate-context option").evaluate_all("(options)=>options.map(o=>o.value)")
        assert context_ids
        page.locator("#delegate-context").select_option(context_ids[0])
        page.locator("#delegate-instructions").fill("Clarify the sampling description without changing other cells.")
        page.get_by_role("button",name="Create delegated task").click()
        expect(page.locator("#delegated-credential")).to_be_visible()
        task_id=page.locator("#delegated-task-id").inner_text()
        secret=page.locator("#delegated-token").input_value()
        assert task_id and secret.startswith("pc-task-")
        endpoint=f"http://127.0.0.1:{port}/api/delegated/{task_id}"
        headers={"Authorization":"Bearer "+secret}
        result=page.request.get(endpoint+"/context",headers=headers)
        assert result.ok
        task=result.json()
        assert task["cell"]["id"]==stable_id
        assert [o["id"] for o in task["context"]]==[context_ids[0]]
        after=task["cell"]["source"].replace("two readings","three readings")
        assert after!=task["cell"]["source"]
        result=page.request.post(endpoint+"/proposal",headers=headers,
            data={"after":after,"rationale":"Fixture proposal from restricted task client.","evidence_ids":context_ids[:1]})
        assert result.ok
        expect(page.get_by_role("textbox",name="Visual block text")).not_to_contain_text("three readings")
        page.get_by_role("button",name="Hide credential").click()
        expect(page.locator("#delegated-token")).to_have_value("")
        page.get_by_role("button",name="Refresh tasks and review").click()
        expect(page.locator("#agent-task-list")).to_contain_text("Quill · pending")
        review=page.locator("#queue article").filter(has_text="Fixture proposal from restricted task client.")
        expect(review).to_contain_text("Original source:")
        expect(review).to_contain_text("Proposed source:")
        review.get_by_role("button",name="Accept",exact=True).click()
        expect(page.locator("#agent-task-list")).to_contain_text("Quill · accepted")
        expect(page.get_by_role("textbox",name="Visual block text")).to_contain_text("three readings")
        expect(page.locator("#create-workflow")).to_be_enabled()
        page.locator("#workflow-title").fill("Sampling workflow")
        page.locator("#workflow-objective").fill("Coordinate two reviewed manuscript revisions.")
        page.get_by_role("button",name="Create research workflow",exact=True).click()
        expect(page.locator("#workflow-list")).to_contain_text("Sampling workflow")
        def add_step(title, dependency=None):
            page.locator("#workflow-step-title").fill(title)
            page.locator("#workflow-cell").select_option(stable_id)
            page.locator("#workflow-assistant").select_option(label="Quill")
            page.locator("#workflow-context").select_option(context_ids[0])
            page.locator("#workflow-instructions").fill("Use only supplied evidence.")
            page.locator("#workflow-criteria").fill("Confirm the sampling statement.")
            if dependency:
                page.locator("#workflow-dependencies").select_option(dependency)
            page.get_by_role("button",name="Add workflow step",exact=True).click()
            step=page.locator(".workflow-step").filter(has=page.locator("strong").filter(has_text=re.compile(r"^\d+\. "+re.escape(title)+r" · ")))
            expect(step).to_have_count(1)
            step_id=step.get_attribute("data-step-id")
            expect(page.get_by_role("button",name="Add workflow step",exact=True)).to_be_enabled()
            return page.locator(f'.workflow-step[data-step-id="{step_id}"]')
        first=add_step("Check sampling")
        second=add_step("Refine sampling",first.get_attribute("data-step-id"))
        expect(first).to_have_attribute("data-status","ready")
        expect(second).to_have_attribute("data-status","blocked")
        expect(second.get_by_role("button",name="Launch step")).to_have_count(0)
        first.get_by_role("button",name="Launch step").click()
        expect(page.locator("#delegated-credential")).to_be_visible()
        task_id=page.locator("#delegated-task-id").inner_text()
        secret=page.locator("#delegated-token").input_value()
        endpoint=f"http://127.0.0.1:{port}/api/delegated/{task_id}"
        headers={"Authorization":"Bearer "+secret}
        result=page.request.get(endpoint+"/context",headers=headers)
        assert result.ok
        task=result.json()
        assert "Acceptance criteria:" in task["instructions"]
        after=task["cell"]["source"].replace("three readings","four readings")
        result=page.request.post(endpoint+"/proposal",headers=headers,
            data={"after":after,"rationale":"Workflow fixture proposal.","evidence_ids":context_ids[:1]})
        assert result.ok
        page.get_by_role("button",name="Hide credential").click()
        page.get_by_role("button",name="Refresh tasks and review").click()
        expect(first).to_have_attribute("data-status","review")
        review=page.locator("#queue article").filter(has_text="Workflow fixture proposal.")
        review.get_by_role("button",name="Accept",exact=True).click()
        expect(first).to_have_attribute("data-status","evaluation")
        expect(second).to_have_attribute("data-status","blocked")
        first.get_by_role("textbox",name="Assessment for Check sampling").fill("Reviewed against the fixture criteria.")
        first.get_by_role("button",name="Pass evaluation").click()
        expect(first).to_have_attribute("data-status","completed")
        expect(second).to_have_attribute("data-status","ready")
        expect(page.locator("#workflow-list")).to_contain_text("1/2 evaluated")
        expect(page.locator("#create-experiment")).to_be_enabled()
        # Real browser registry/receipt round trip; synthetic receipt is
        # intentionally distinct from the actual container CI workflow.
        import hashlib
        import json
        from pathlib import Path
        from tempfile import TemporaryDirectory
        for kind,title,body in [("code","Fixture computation","print(42)"),("dataset","Fixture inputs","1,2,3")]:
            page.locator("#object-kind").select_option(kind)
            page.locator("#object-title").fill(title)
            page.locator("#object-id").fill("")
            page.locator("#object-body").fill(body)
            page.get_by_role("button",name="Add object",exact=True).click()
            expect(page.locator("#library")).to_contain_text(title)
            expect(page.locator("#create-experiment")).to_be_enabled()
        page.locator("#experiment-title").fill("Fixture experiment")
        page.locator("#experiment-objective").fill("Review the computation receipt.")
        page.locator("#experiment-language").select_option("python")
        image="sha256:"+"a"*64
        page.locator("#experiment-image").fill(image)
        page.locator("#experiment-code").select_option(label="Fixture computation · v1")
        page.locator("#experiment-datasets").select_option(label="Fixture inputs · v1")
        page.get_by_role("button",name="Register experiment").click()
        run=page.locator(".experiment-record").filter(has_text="Fixture experiment")
        expect(run).to_contain_text("planned")
        with TemporaryDirectory() as directory:
            with page.expect_download() as download:
                run.get_by_role("button",name="Download experiment bundle").click()
            path=Path(directory)/"bundle.json"
            download.value.save_as(path)
            bundle=json.loads(path.read_text())
            assert bundle["spec"]["code"]["body"]=="print(42)"
            assert bundle["spec"]["datasets"][0]["body"]=="1,2,3"
            log="42\n"
            receipt={"format":"papercolab-receipt-v1","experiment_id":bundle["spec"]["id"],
                     "bundle_sha256":bundle["sha256"],"image":image,"runner":"docker-local-v1",
                     "status":"succeeded","exit_code":0,"elapsed_ms":10,
                     "log":log,"log_sha256":hashlib.sha256(log.encode()).hexdigest()}
            path=Path(directory)/"receipt.json"
            path.write_text(json.dumps(receipt))
            run.get_by_label("Runner receipt for Fixture experiment").set_input_files(path)
            run.get_by_role("button",name="Import runner receipt").click()
            expect(run).to_contain_text("review")
            run.get_by_role("textbox",name="Experiment assessment for Fixture experiment").fill("Synthetic fixture receipt reviewed.")
            run.get_by_role("button",name="Accept as run evidence").click()
            expect(run).to_contain_text("accepted")
            expect(page.locator("#library")).to_contain_text("run · Fixture experiment")
    page.close()
    assert not errors, errors


if __name__ == "__main__":
    main()
