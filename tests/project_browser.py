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
        page.get_by_role("button", name="Document", exact=True).click()
        expect(heading.locator(".visual-prose")).to_contain_text("Revised")
        expect(paragraph.locator(".visual-prose")).to_contain_text("Independent")
        table=cells.locator(".scientific-panel").filter(has=page.locator("table")).first
        expect(table.get_by_role("textbox",name="Row 2, column 2",exact=True)).to_have_value("4")
        table.get_by_role("textbox",name="Row 2, column 2",exact=True).fill("8")
        cells.locator(".manuscript-cell").filter(has=table).get_by_role("button",name="Save cell",exact=True).click()
        expect(table.get_by_role("textbox",name="Row 2, column 2",exact=True)).to_have_value("8")
        page.get_by_role("button", name="Focused", exact=True).click()
    page.close()
    assert not errors, errors


if __name__ == "__main__":
    main()
