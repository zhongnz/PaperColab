"""Exercise bidirectional cell editing and review in two Chromium sessions."""
import base64
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
            exercise_invitation(browser, port)
            exercise_cell_structure(browser, port)
            exercise_preview(browser, port)
            browser.close()
        server.shutdown()
        service.close()
    print("Workspace browser flow passed.")


def exercise(browser, port, width):
    page = browser.new_page(viewport={"width": width, "height": 900})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    url = f"http://127.0.0.1:{port}/"
    page.goto(url)
    expect(page.get_by_role("heading", name="Manuscript workspace")).to_be_visible()
    page.locator("#actor").select_option("demo-bao")
    expect(page.locator("#who")).to_contain_text("Bao")
    expect(page.locator("#project-title")).to_have_text("Estuary field notes")
    paragraph = page.locator("#blocks").get_by_role("button", name=re.compile("fictional field notebook"))
    paragraph.click()
    prose = page.get_by_role("textbox", name="Visual block text")
    expect(prose).to_be_visible()
    if width == 1440:
        exercise_legacy_drafts(page, prose)
        prose.click()
        prose.press("Control+Home")
        page.keyboard.insert_text("Checked ")
        source = page.get_by_label("Block LaTeX source")
        expect(source).to_contain_text("Checked This fictional")
        source.press("Control+Home")
        page.keyboard.insert_text("Source draft ")
        expect(prose).to_contain_text("Source draft Checked This fictional")
        source.press("Control+End")
        page.keyboard.insert_text(r" $x^2$ \cite{celltest}")
        expect(prose.locator("math")).to_have_count(1)
        expect(prose.get_by_text(r"\cite{celltest}", exact=True)).to_be_visible()
        expect(page.locator("#cell-draft-status")).to_contain_text("saved in this browser")

        source.press("Control+End")
        page.keyboard.insert_text("\n\nA second paragraph.")
        expect(page.locator("#cell-draft-status")).to_contain_text("last valid version")
        expect(prose).not_to_contain_text("A second paragraph")
        expect(prose).to_have_attribute("contenteditable", "false")
        proposal = page.get_by_role("button", name="Propose cell edit")
        expect(proposal).to_be_disabled()
        page.get_by_role("button", name=re.compile("Sampling method")).click()
        paragraph.click()
        expect(source).to_contain_text("A second paragraph")
        page.reload()
        expect(prose).to_contain_text("Source draft Checked")
        expect(source).to_contain_text("A second paragraph")
        page.get_by_role("button", name="Restore last valid LaTeX").click()
        expect(source).not_to_contain_text("A second paragraph")
        expect(prose).to_have_attribute("contenteditable", "true")
        prose.press("Control+Home")
        page.keyboard.insert_text("Reviewed ")
        expect(source).to_contain_text("Reviewed Source draft Checked")
        project = page.locator("#project-title").get_attribute("data-id")
        reviewer = browser.new_page(viewport={"width": width, "height": 900})
        reviewer.on("pageerror", lambda error: errors.append(str(error)))
        reviewer.goto(url + "?project=" + project)
        reviewer.locator("#actor").select_option("demo-iris")
        expect(reviewer.locator("#who")).to_contain_text("Iris")
        expect(reviewer.get_by_label("Block LaTeX source")).not_to_contain_text("Source draft")

        page.get_by_label("Comment", exact=True).fill("Check that this remains attached to the method paragraph.")
        page.get_by_role("button", name="Comment on this cell").click()
        expect(reviewer.locator("#threads")).to_contain_text("Check that this remains attached", timeout=12000)
        reviewer.get_by_role("button", name="Reply to thread").click()
        reviewer.get_by_label("Comment", exact=True).fill("Verified against the protocol.")
        reviewer.get_by_role("button", name="Post reply").click()
        expect(page.locator("#threads")).to_contain_text("Verified against the protocol.", timeout=12000)

        proposal.click()
        expect(page.locator("#queue")).to_contain_text("Bao")
        expect(page.locator("#queue")).to_contain_text("visual · pending")
        accept = reviewer.get_by_role("button", name="Accept", exact=True)
        expect(accept).to_be_visible(timeout=12000)
        page.context.set_offline(True)
        source.press("Control+Home")
        page.keyboard.insert_text("Offline ")
        accept.click()
        reviewer.get_by_role("button", name="Resolve comment").first.click()
        expect(reviewer.locator("#threads")).to_contain_text("Bao · resolved")
        page.context.set_offline(False)
        expect(page.locator("#queue")).to_contain_text("accepted", timeout=12000)
        expect(page.locator("#threads")).to_contain_text("Bao · resolved")
        expect(prose).to_contain_text("Offline This fictional")
        expect(source).to_contain_text("Offline This fictional")
        expect(proposal).to_be_disabled()
        expect(page.locator("#current-source")).to_contain_text("Reviewed Source draft Checked")
        page.get_by_role("button", name="Use current revision as base").click()
        expect(source).to_contain_text("Offline This fictional")
        expect(proposal).to_be_enabled()
        source.press("Control+Home")
        page.keyboard.insert_text("Reviewed Source draft Checked ")
        source.press("Control+End")
        page.keyboard.insert_text(r" \cite{celltest}")
        proposal.click()
        expect(reviewer.locator("#queue")).to_contain_text("source · pending", timeout=12000)
        accept.click()
        expect(source).to_contain_text("Reviewed Source draft Checked Offline", timeout=12000)
        reviewer.close()
        with page.expect_download() as download:
            page.get_by_role("button", name="Download current ZIP").click()
        assert download.value.suggested_filename.endswith(".zip")
        encoded = page.evaluate("""async () => {
          const id = document.getElementById('project-title').dataset.id;
          const response = await fetch('/api/projects/' + id + '/export');
          const payload = await response.json();
          return payload.zip_b64;
        }""")
        with zipfile.ZipFile(io.BytesIO(base64.b64decode(encoded))) as archive:
            source_bytes = archive.read("estuary/sections/methods.tex")
            assert b"Reviewed Source draft Checked Offline " in source_bytes
            assert rb"\cite{celltest}" in source_bytes
            original = (Path(__file__).resolve().parents[1] / "examples/estuary/sections/methods.tex").read_bytes()
            assert source_bytes.split(rb"\begin{tabular}", 1)[1] == original.split(rb"\begin{tabular}", 1)[1]
    page.close()
    assert not errors, errors


def exercise_legacy_drafts(page, prose):
    page.evaluate("""async () => {
      const projectId = document.querySelector('#project-title').dataset.id;
      const actor = await fetch('/api/me').then(response => response.json());
      const project = await fetch('/api/projects/' + projectId).then(response => response.json());
      const blockId = document.querySelector('#blocks [aria-current=true]').dataset.block;
      const block = project.blocks.find(block => block.stableId === blockId);
      const key = `papercolab-draft:${actor.id}:${projectId}:${blockId}:`;
      const base = { blockId, path: block.path, before: block.quote, projectRevision: project.revision, blockRevision: block.revision };
      const rich = PaperColabBlocks.parseFile(block.quote).blocks[0].rich;
      rich.content[0].content[0].text = 'Legacy visual ' + rich.content[0].content[0].text;
      localStorage.setItem(key + 'visual', JSON.stringify({ ...base, content: rich }));
      localStorage.setItem(key + 'source', JSON.stringify({ ...base, content: 'Legacy source ' + block.quote }));
    }""")
    page.reload()
    expect(prose).to_contain_text("Legacy source")
    page.get_by_text(re.compile("Earlier draft ·")).click()
    expect(page.locator("#detached-drafts pre")).to_contain_text("Legacy visual")
    page.get_by_role("button", name="Discard draft", exact=True).click()
    page.get_by_role("button", name="Open earlier draft").click()
    expect(prose).to_contain_text("Legacy visual")
    expect(page.get_by_label("Block LaTeX source")).to_contain_text("Legacy visual")
    page.get_by_role("button", name="Discard draft", exact=True).click()


def exercise_invitation(browser, port):
    url = f"http://127.0.0.1:{port}/"
    lead = browser.new_page()
    guest = browser.new_page()
    errors = []
    for page in (lead, guest):
        page.on("pageerror", lambda error: errors.append(str(error)))
    lead.goto(url)
    expect(lead.locator("#who")).to_contain_text("Ada")
    lead.get_by_role("button", name=re.compile("Estuary field notes")).click()
    lead.get_by_text("Manage access", exact=True).click()
    lead.get_by_role("button", name="Create invitation").click()
    link = lead.get_by_label("Invitation link")
    expect(link).to_have_value(re.compile(r"/invite\.html#code="))
    guest.goto(link.input_value())
    guest.get_by_label("Display name").fill("Devon")
    guest.get_by_role("button", name="Accept invitation").click()
    expect(guest.get_by_label("Sign-in key")).not_to_be_empty()
    guest.get_by_role("link", name="Open the project").click()
    expect(guest.locator("#who")).to_contain_text("Devon")
    expect(guest.locator("#project-title")).to_have_text("Estuary field notes")
    source = guest.get_by_label("Block LaTeX source")
    expect(source).to_have_attribute("aria-readonly", "false")
    lead.get_by_text("Cell permissions", exact=True).click()
    lead.get_by_label("Block owner").select_option(label="Bao")
    expect(source).to_have_attribute("aria-readonly", "true", timeout=12000)
    lead.get_by_label("Allow AI proposals for this cell").check()
    expect(lead.get_by_label("Allow AI proposals for this cell")).to_be_checked()
    for page in (lead, guest):
        page.close()
    assert not errors, errors


def exercise_cell_structure(browser, port):
    url = f"http://127.0.0.1:{port}"
    page = browser.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(url)
    expect(page.locator("#who")).to_contain_text("Ada")
    page.get_by_text("Add or find a project", exact=True).click()
    page.locator("#new-title").fill("A new paper")
    page.get_by_role("button", name="Create project", exact=True).click()
    expect(page.locator("#project-title")).to_have_text("A new paper")
    expect(page.locator("#file")).to_have_value("main.tex")

    page.get_by_text("Add a cell", exact=True).click()
    source = "This paragraph was added through the cell editor."
    page.get_by_label("Cell LaTeX").fill(source)
    page.get_by_role("button", name="Add cell", exact=True).click()
    expect(page.get_by_role("textbox", name="Visual block text")).to_have_text(source)
    active = page.locator("#blocks [aria-current=true]")
    expect(active).to_contain_text("Cell 4")
    page.get_by_role("button", name="Move up", exact=True).click()
    expect(active).to_contain_text("Cell 3")

    project = page.locator("#project-title").get_attribute("data-id")
    output = page.request.get(f"{url}/api/projects/{project}/export").json()
    with zipfile.ZipFile(io.BytesIO(base64.b64decode(output["zip_b64"]))) as archive:
        manuscript = archive.read("main.tex").decode()
        assert manuscript.count(source) == 1
        assert manuscript.index(source) < manuscript.index("Write the first paragraph")
    page.close()
    assert not errors, errors


def exercise_preview(browser, port):
    url = f"http://127.0.0.1:{port}/"
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(url)
    expect(page.locator("#project-title")).to_have_text("Estuary field notes")
    page.get_by_role("button", name="Preview manuscript", exact=True).click()
    panel = page.locator("#manuscript-preview")
    paper = page.locator("#preview-manuscript")
    expect(panel).to_be_visible()
    assert panel.bounding_box()["x"] > page.locator(".cell-workbench").bounding_box()["x"]
    expect(paper.get_by_role("heading", name="Sampling method")).to_be_visible()
    expect(paper).to_contain_text("fictional field notebook")
    assert paper.text_content().index("Sampling method") < paper.text_content().index("fictional field notebook")

    prose = page.get_by_role("textbox", name="Visual block text")
    prose.press("Control+Home")
    page.keyboard.insert_text("Preview paragraph ")
    page.locator("#blocks").get_by_role("button", name=re.compile("Sampling method")).click()
    source = page.get_by_label("Block LaTeX source")
    source.fill(r"\section{Preview heading}")
    expect(paper.get_by_role("heading", name="Preview heading")).to_be_visible()
    expect(paper).to_contain_text("Preview paragraph")
    source.fill(r"\section{Invalid heading")
    expect(page.locator("#preview-draft-status")).to_contain_text("1 draft needs attention")
    expect(paper.get_by_role("heading", name="Sampling method")).to_be_visible()
    expect(paper).to_contain_text("Preview paragraph")
    page.get_by_role("button", name="Restore last valid LaTeX").click()
    expect(paper.get_by_role("heading", name="Preview heading")).to_be_visible()
    page.get_by_label("Include saved drafts").uncheck()
    expect(paper.get_by_role("heading", name="Sampling method")).to_be_visible()
    expect(paper).not_to_contain_text("Preview paragraph")
    page.get_by_label("Include saved drafts").check()

    requests = []
    project = page.locator("#project-title").get_attribute("data-id")
    revision = page.request.get(f"{url}api/projects/{project}").json()["revision"]

    def build(route):
        body = route.request.post_data_json
        requests.append(body)
        if len(requests) == 1:
            route.fulfill(status=422, json={"error": "TeX build failed.", "diagnostics": "main.tex:9: Undefined control sequence."})
            return
        route.fulfill(json={"pdf_b64": example_pdf(), "root": body["root"], "engine": body["engine"],
                            "revision": revision, "draft_count": len(body["drafts"])})

    page.route("**/api/projects/*/preview", build)
    build_pdf = page.get_by_role("button", name="Build PDF", exact=True)
    build_pdf.click()
    expect(page.locator("#preview-status")).to_contain_text("TeX build failed")
    expect(page.locator("#preview-error-log")).to_have_text("main.tex:9: Undefined control sequence.")
    expect(paper.get_by_role("heading", name="Preview heading")).to_be_visible()
    build_pdf.click()
    frame = page.locator("#preview-pdf")
    expect(frame).to_be_visible()
    expect(page.locator("#preview-status")).to_contain_text("with 2 saved drafts")
    pdf_url = page.get_by_role("link", name="Open PDF in new tab").get_attribute("href")
    viewer_url = frame.get_attribute("src")
    assert pdf_url.startswith("blob:") and viewer_url.startswith(pdf_url + "#")
    assert requests[-1]["root"] == "estuary/main.tex"
    assert requests[-1]["engine"] == "pdflatex"
    assert len(requests[-1]["drafts"]) == 2
    assert any(draft["source"].startswith("Preview paragraph") for draft in requests[-1]["drafts"])
    assert any(draft["source"] == r"\section{Preview heading}" for draft in requests[-1]["drafts"])
    page.get_by_role("button", name="Manuscript", exact=True).click()
    expect(paper.get_by_role("heading", name="Preview heading")).to_be_visible()
    page.get_by_role("button", name="PDF", exact=True).click()
    expect(frame).to_have_attribute("src", viewer_url)
    page.evaluate("""() => {
      window.revokedPreviewUrls = [];
      const revoke = URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL = url => { window.revokedPreviewUrls.push(url); revoke(url); };
    }""")
    page.get_by_role("button", name="Hide preview", exact=True).click()
    expect(panel).to_be_hidden()
    assert page.evaluate("window.revokedPreviewUrls") == [pdf_url]
    assert frame.get_attribute("src") is None
    page.get_by_role("button", name="Preview manuscript", exact=True).click()
    build_pdf.click()
    expect(frame).to_be_visible()
    next_pdf_url = page.get_by_role("link", name="Open PDF in new tab").get_attribute("href")
    page.locator("#project-list").get_by_role("button", name=re.compile("A new paper")).click()
    expect(page.locator("#project-title")).to_have_text("A new paper")
    expect(panel).to_be_hidden()
    assert page.evaluate("window.revokedPreviewUrls") == [pdf_url, next_pdf_url]
    assert frame.get_attribute("src") is None
    page.close()
    assert not errors, errors


def example_pdf():
    parts = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
             b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>",
             b"<< /Length 0 >>\nstream\nendstream"]
    pdf = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, data in enumerate(parts, 1):
        offsets.append(len(pdf))
        pdf.extend(f"{number} 0 obj\n".encode() + data + b"\nendobj\n")
    xref = len(pdf)
    pdf.extend(b"xref\n0 5\n0000000000 65535 f \n")
    for offset in offsets:
        pdf.extend(f"{offset:010d} 00000 n \n".encode())
    pdf.extend(f"trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return base64.b64encode(pdf).decode()


if __name__ == "__main__":
    main()
