"""Exercise both browser entry points. Install Playwright and Chrome or Chromium to run."""
import argparse
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import zipfile
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def multi_zip():
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as z:
        for name in ["a", "b"]:
            z.writestr(name + "/main.tex", r"\documentclass{article}\begin{document}\input{methods}\end{document}")
        z.writestr("b/methods.tex", "Paper prose that should stay out of the report.")
    return stream.getvalue()


def exercise(browser, uri, width, screenshots=None):
    ctx = browser.new_context(viewport={"width": width, "height": 900}, accept_downloads=True, offline=True)
    page = ctx.new_page()
    errors, requests = [], []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
    page.on("request", lambda request: requests.append(request.url) if request.url.startswith(("http:", "https:")) else None)
    page.goto(uri)
    if screenshots:
        page.screenshot(path=screenshots / f"start-{width}.png", full_page=True)
    page.get_by_role("button", name="Inspect example").click()
    page.wait_for_selector("#report:visible")
    assert page.locator("#root").input_value() == "estuary/main.tex"
    assert "No missing" in page.locator("#root-status").inner_text()
    if screenshots:
        page.screenshot(path=screenshots / f"report-{width}.png", full_page=True)
    page.locator("#file").set_input_files({"name": "group.zip", "mimeType": "application/zip", "buffer": multi_zip()})
    page.get_by_role("heading", name="group.zip", exact=True).wait_for()
    assert "methods" in page.locator("#root-notes").inner_text()
    page.locator("#root").select_option("b/main.tex")
    assert "No missing" in page.locator("#root-status").inner_text()
    with page.expect_download() as event:
        page.get_by_role("button", name="Save report").click()
    report = json.loads(event.value.path().read_text())
    assert report["selectedManuscript"]["root"] == "b/main.tex" and report["build"] == "not-run"
    assert "Paper prose" not in json.dumps(report)
    for selector in ["main", "#report", "#report-heading", ".actions", "#root"]:
        bounds = page.locator(selector).bounding_box()
        assert 0 <= bounds["x"] and bounds["x"] + bounds["width"] <= width + 1, selector
    page.locator("#file").set_input_files({"name": "broken.zip", "mimeType": "application/zip", "buffer": b"bad"})
    page.wait_for_selector("#error:visible")
    assert not page.locator("#report").is_visible()
    assert not requests, requests
    assert not errors, errors
    ctx.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--screenshots", type=Path)
    args = parser.parse_args()
    if args.screenshots:
        args.screenshots.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp, sync_playwright() as pw:
        bundle = Path(tmp) / "PaperColab.html"
        subprocess.run([sys.executable, str(ROOT / "scripts/package.py"), "--html", str(bundle)], check=True)
        chrome = shutil.which("google-chrome") or shutil.which("chromium") or shutil.which("chromium-browser")
        browser = pw.chromium.launch(executable_path=chrome)
        for uri in [(ROOT / "web/index.html").as_uri(), bundle.as_uri()]:
            for width in (390, 1440):
                exercise(browser, uri, width, args.screenshots if uri == bundle.as_uri() else None)
        browser.close()
    print("Browser checks passed for both entry points at both widths, with networking disabled.")
