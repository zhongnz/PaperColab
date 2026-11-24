"""Exercise the real hosted editor against the opt-in checkpoint API."""
from pathlib import Path
import sys
import tempfile
from http.server import ThreadingHTTPServer
from threading import Thread
from shutil import which
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from server.service import Service
from server.http_app import Api
from server.__main__ import make_handler

def run(browser, url, service):
    a, b = browser.new_page(), browser.new_page()
    errors, posts = [], []
    for page in (a, b):
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("request", lambda req: posts.append(req.post_data_json)
                if req.method == "POST" and req.url.endswith("/crdt") else None)
        page.goto(url)
        page.locator("#actor").select_option("demo-bao")
        expect(page.locator("#who")).to_contain_text("Bao")
        page.get_by_role("button", name="Estuary field notes · author").click()
        expect(page.locator("#crdt-option")).to_be_visible()
        page.get_by_role("checkbox", name="Experimental Yjs saves").check()
        expect(page.locator('#blocks button[data-kind="paragraph"]').first).to_be_visible()
        page.locator('#blocks button[data-kind="paragraph"]').first.click()
    prose = a.get_by_role("textbox", name="Visual block text")
    other = b.get_by_role("textbox", name="Visual block text")
    prose.click(); prose.press("Control+Home"); a.keyboard.insert_text("Café 🐋 ")
    a.get_by_role("button",name="Save cell directly").click()
    expect(a.locator("#status")).to_contain_text("saved via Yjs")
    expect(other).to_contain_text("Café 🐋", timeout=15000)
    other.click(); other.press("Control+Home"); b.keyboard.insert_text("Stale draft ")
    prose.click(); prose.press("Control+Home"); a.keyboard.insert_text("Remote ")
    a.get_by_role("button",name="Save cell directly").click()
    expect(a.locator("#status")).to_contain_text("saved via Yjs")
    expect(b.locator("#sync-state")).to_contain_text("Your local draft is retained",timeout=15000)
    b.get_by_role("button",name="Save cell directly").click()
    expect(b.locator("#error")).to_contain_text("This cell changed remotely")
    expect(other).to_contain_text("Stale draft")
    b.get_by_role("button",name="Discard local draft").click()
    expect(other).to_contain_text("Remote")
    a.get_by_role("button",name="Cells",exact=True).click()
    cell=a.locator("#hosted-cells .cell-paragraph").first
    cell.get_by_role("button",name="LaTeX",exact=True).click()
    source=cell.locator("textarea.hosted-source")
    source.fill(source.input_value().replace("two readings","three readings"))
    cell.get_by_role("button",name="Apply LaTeX draft").click()
    expect(cell.locator(".visual-prose")).to_contain_text("three readings")
    cell.get_by_role("button",name="Save cell",exact=True).click()
    expect(a.locator("#status")).to_contain_text("saved via Yjs")
    expect(a.locator("#hosted-draft-count")).to_have_text("0 unsaved cells")
    expect(other).to_contain_text("three readings",timeout=15000)
    assert len(posts)==3, posts
    assert all(set(p)=={"version","epoch","update"} for p in posts)
    with service.lock:
        assert service.db.execute("SELECT count(*) FROM crdt_cells").fetchone()[0]==1
        assert service.db.execute("SELECT count(*) FROM audit WHERE action='crdt-checkpoint'").fetchone()[0]==3
    assert not errors, errors
    a.close(); b.close()

if __name__=="__main__":
    with tempfile.TemporaryDirectory() as tmp:
        service=Service(Path(tmp)/"trial.sqlite",demo=True,crdt=True)
        server=ThreadingHTTPServer(("127.0.0.1",0),make_handler(Api(service)))
        thread=Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            with sync_playwright() as pw:
                browser=pw.chromium.launch(executable_path=which("google-chrome") or which("chromium"))
                run(browser,"http://127.0.0.1:"+str(server.server_address[1]),service)
                browser.close()
        finally:
            server.shutdown();server.server_close();thread.join();service.close()
    print("Hosted Yjs checkpoint browser test passed.")
