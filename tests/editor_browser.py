"""Edit through the real visual/source panes offline and compare the exported project bytes."""
import argparse
import base64
import io
from pathlib import Path
import shutil
import sys
import tempfile
import zipfile

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from package import demo_zip, single_html


def read_files(data):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        assert archive.testzip() is None
        return {name: archive.read(name) for name in archive.namelist()}


def exercise(browser, uri, width, screenshots, output_zip):
    context = browser.new_context(viewport={"width": width, "height": 900}, offline=True, accept_downloads=True)
    page = context.new_page()
    errors, remote = [], []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("request", lambda r: remote.append(r.url) if r.url.startswith(("http:", "https:")) else None)
    page.goto(uri)
    page.get_by_role("button", name="Open example editor", exact=True).click()
    expect(page.get_by_role("button", name="Document", exact=True)).to_have_attribute("aria-pressed", "true")
    page.get_by_role("button", name="Cells", exact=True).click()
    heading = page.locator(".manuscript-cell.cell-heading").first
    paragraph = page.locator(".manuscript-cell.cell-paragraph").first
    expect(heading.locator(".visual-prose")).to_contain_text("Sampling method")
    expect(paragraph.locator(".visual-prose")).to_contain_text("two readings")
    heading.get_by_role("button", name="Edit LaTeX", exact=True).click()
    heading.locator("textarea").fill(r"\section{Cell view test}")
    expect(page.get_by_role("button", name="Split", exact=True)).to_be_disabled()
    heading.get_by_role("button", name="Apply LaTeX").click()
    expect(heading.locator(".visual-prose")).to_have_text("Cell view test")
    paragraph.locator(".visual-prose").click()
    paragraph.locator(".visual-prose").press("Control+Home")
    page.keyboard.insert_text("Cell prose. ")
    paragraph.get_by_role("button", name="Edit LaTeX", exact=True).click()
    assert "Cell prose." in paragraph.locator("textarea").input_value()
    page.get_by_role("button", name="Document", exact=True).click()
    expect(page.locator(".manuscript-cell.cell-heading .visual-prose").first).to_have_text("Cell view test")
    expect(page.locator(".manuscript-cell.cell-paragraph .visual-prose").first).to_contain_text("Cell prose.")
    page.get_by_role("button", name="Cells", exact=True).click()
    heading.get_by_role("button", name="Revert", exact=True).click()
    paragraph.get_by_role("button", name="Revert", exact=True).click()
    expect(page.locator("#edit-count")).to_have_text("Original manuscript")
    scientific = page.locator(".scientific-cell").filter(has=page.locator(".scientific-panel table"))
    expect(scientific).to_have_count(1)
    value = scientific.get_by_role("textbox", name="Row 2, column 2", exact=True)
    expect(value).to_have_value("4")
    value.fill("7")
    expect(page.get_by_role("button", name="Split", exact=True)).to_be_disabled()
    scientific.get_by_role("button", name="Apply scientific fields").click()
    expect(value).to_have_value("7")
    with page.expect_download() as science_export:
        page.get_by_role("button", name="Export project ZIP").click()
    before_science = read_files(demo_zip())
    after_science = read_files(science_export.value.path().read_bytes())
    methods = "estuary/sections/methods.tex"
    assert after_science[methods] == before_science[methods].replace(b"Upstream & 4 & 5", b"Upstream & 7 & 5")
    assert all(after_science[k] == v for k, v in before_science.items() if k != methods)
    page.get_by_role("button", name="Undo structure").click()
    expect(value).to_have_value("4")
    page.locator("#block-list button").filter(has_text="tabular").click()
    page.get_by_role("button", name="Split", exact=True).click()
    split_field = page.get_by_role("textbox", name="Row 2, column 2", exact=True)
    split_source = page.locator("#source-surface .cm-content")
    expect(split_field).to_have_value("4")
    split_field.fill("8")
    page.get_by_role("button", name="Apply scientific fields").click()
    expect(split_source).to_contain_text("Upstream & 8 & 5")
    split_source.click()
    split_source.press("Control+a")
    page.keyboard.insert_text(("\\begin{tabular}" + before_science[methods].decode().split("\\begin{tabular}", 1)[1]).strip().replace("Upstream & 4 & 5", "Upstream & 9 & 5"))
    page.get_by_role("button", name="Apply source", exact=True).click()
    expect(split_field).to_have_value("9")
    page.get_by_role("button", name="Undo structure").click()
    expect(split_field).to_have_value("8")
    page.get_by_role("button", name="Undo structure").click()
    expect(split_field).to_have_value("4")
    page.get_by_role("button", name="Cells", exact=True).click()
    paragraph.get_by_role("combobox", name="Citation key").select_option("fieldguide")
    paragraph.get_by_role("button", name="Append citation", exact=True).click()
    expect(paragraph.locator(".tex-token")).to_have_count(2)
    paragraph.get_by_role("button", name="Revert", exact=True).click()
    expect(paragraph.locator(".tex-token")).to_have_count(1)
    original_ids = page.locator(".manuscript-cell").evaluate_all("(cells) => cells.map(c => c.dataset.blockId)")
    paragraph.get_by_role("button", name="Add paragraph", exact=True).click()
    added = page.locator(".manuscript-cell").filter(has=page.locator(".visual-prose").filter(has_text="New paragraph."))
    expect(added).to_have_count(1)
    expect(page.locator("#edit-count")).to_have_text("Structural changes")
    added.get_by_role("button", name="Make heading", exact=True).click()
    expect(added).to_have_class("manuscript-cell cell-heading active-cell")
    page.get_by_role("button", name="Undo structure").click()
    expect(added).to_have_class("manuscript-cell cell-paragraph active-cell")
    page.get_by_role("button", name="Undo structure").click()
    assert page.locator(".manuscript-cell").evaluate_all("(cells) => cells.map(c => c.dataset.blockId)") == original_ids
    expect(page.locator("#edit-count")).to_have_text("Original manuscript")
    page.get_by_role("button", name="Block source", exact=True).click()
    expect(page.locator("#visual-section")).to_be_hidden()
    page.get_by_role("button", name="Split", exact=True).click()
    visual = page.get_by_role("textbox", name="Visual block text")
    code = page.locator("#source-surface .cm-content")
    export = page.get_by_role("button", name="Export project ZIP")
    expect(visual).to_contain_text("two readings")
    expect(page.locator("#editor-file")).to_have_value("estuary/sections/methods.tex")
    with page.expect_download() as unchanged:
        export.click()
    assert unchanged.value.path().read_bytes() == demo_zip()

    visual.click()
    visual.press("Control+Home")
    page.keyboard.insert_text("Replicate samples. ")
    expect(code).to_contain_text("Replicate samples.")
    page.get_by_role("button", name="Undo", exact=True).click()
    expect(visual).not_to_contain_text("Replicate samples.")
    expect(page.locator("#edit-count")).to_have_text("Original manuscript")
    page.get_by_role("button", name="Redo", exact=True).click()
    expect(visual).to_contain_text("Replicate samples.")
    expect(visual.locator(".tex-token")).to_have_text(r"\cite{fieldguide}")

    visual.press("Control+Home")
    for _ in "Replicate":
        visual.press("Shift+ArrowRight")
    bold = page.get_by_role("button", name="Bold", exact=True)
    italic = page.get_by_role("button", name="Italic", exact=True)
    bold.click()
    italic.click()
    expect(code).to_contain_text(r"\textbf{\emph{Replicate}}")
    italic.click()
    bold.click()
    expect(code).not_to_contain_text(r"\textbf")
    visual.press("Control+a")
    visual.press("Backspace")
    expect(visual.locator(".tex-token")).to_have_text(r"\cite{fieldguide}")
    expect(page.locator("#edit-message")).to_contain_text("LaTeX pane")
    visual.press("Home")

    if screenshots:
        page.screenshot(path=screenshots / f"editor-{width}.png", full_page=True)
    for selector in ["main", ".outline", ".sheet", "#visual-surface", "#source-surface"]:
        rect = page.locator(selector).bounding_box()
        assert rect and 0 <= rect["x"] and rect["x"] + rect["width"] <= width + 1, selector

    page.locator("#block-list button").filter(has_text="Sampling method").click()
    code.click()
    code.press("Control+a")
    page.keyboard.insert_text(r"\section{Revised sampling}")
    expect(export).to_be_disabled()
    page.get_by_role("button", name="Apply source").click()
    expect(visual).to_have_text("Revised sampling")
    expect(page.locator("#edit-count")).to_have_text("2 edited blocks")
    code.click()
    code.press("Control+a")
    page.keyboard.insert_text(r"\unknown{invalid}")
    page.get_by_role("button", name="Apply source").click()
    expect(page.locator("#edit-message")).to_contain_text("Keep one supported")
    expect(page.locator("#editor-file")).to_be_disabled()
    page.get_by_role("button", name="Discard draft").click()
    expect(code).to_have_text(r"\section{Revised sampling}")

    page.locator("#block-list button").filter(has_text="tabular").click()
    expect(code).to_have_attribute("aria-readonly", "false")
    expect(code).to_contain_text(r"\bottomrule")
    expect(visual).to_have_count(0)
    expect(page.get_by_role("textbox", name="Row 2, column 2", exact=True)).to_have_value("4")
    page.get_by_role("button", name="Archive report").click()
    page.get_by_role("button", name="Edit manuscript").click()
    expect(visual).to_contain_text("Replicate samples.")
    with page.expect_download() as changed:
        export.click()
    data = changed.value.path().read_bytes()
    before, after = read_files(demo_zip()), read_files(data)
    assert list(before) == list(after)
    name = "estuary/sections/methods.tex"
    for path in before:
        if path != name:
            assert before[path] == after[path], path
    old, new = before[name].split(b"\\begin{tabular}"), after[name].split(b"\\begin{tabular}")
    assert old[1] == new[1]
    assert new[0].startswith(b"\\section{Revised sampling}\nReplicate samples. ")
    assert b"protocol~\\cite{fieldguide}" in new[0]
    if output_zip:
        output_zip.parent.mkdir(exist_ok=True, parents=True)
        output_zip.write_bytes(data)
    page.get_by_role("button", name="Revert block").click()
    expect(visual).not_to_contain_text("Replicate samples.")
    expect(page.locator("#edit-count")).to_have_text("1 edited block")
    # A second imported manuscript exercises local raster preview, including
    # the single-file build's restrictive CSP. No asset is fetched remotely.
    page.get_by_role("button", name="Archive report").click()
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as z:
        z.writestr("main.tex", r"\documentclass{article}" + "\n" + r"\begin{document}" + "\n\n" +
                   "Figure below.\n\n" + r"\begin{figure}\includegraphics{a.png}\caption{Sample image}\end{figure}" +
                   "\n\n" + r"\end{document}")
        z.writestr("a.png", base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/XqkAAAAASUVORK5CYII="))
    page.on("dialog", lambda dialog: dialog.accept())
    page.locator("#file").set_input_files({"name":"figure.zip","mimeType":"application/zip","buffer":stream.getvalue()})
    page.get_by_role("heading", name="figure.zip", exact=True).wait_for()
    page.get_by_role("button", name="Edit manuscript").click()
    page.get_by_role("button", name="Preview local image").click()
    image = page.get_by_role("img", name="Sample image")
    expect(image).to_be_visible()
    assert image.evaluate("(img) => img.complete && img.naturalWidth === 1")
    assert image.get_attribute("src").startswith("blob:")
    assert not remote, remote
    assert not errors, errors
    context.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--screenshots", type=Path)
    parser.add_argument("--output-zip", type=Path)
    args = parser.parse_args()
    if args.screenshots:
        args.screenshots.mkdir(exist_ok=True, parents=True)
    with tempfile.TemporaryDirectory() as temp, sync_playwright() as playwright:
        single = Path(temp) / "PaperColab.html"
        single.write_text(single_html(), encoding="utf-8")
        chrome = shutil.which("google-chrome") or shutil.which("chromium") or shutil.which("chromium-browser")
        browser = playwright.chromium.launch(executable_path=chrome)
        for path in [ROOT / "web/index.html", single]:
            for width in [1440, 390]:
                exercise(browser, path.as_uri(), width, args.screenshots if path == single else None,
                         args.output_zip if path == single and width == 1440 else None)
        browser.close()
    print("Visual/source edits and exact exports verified offline at two widths and both entry points.")
