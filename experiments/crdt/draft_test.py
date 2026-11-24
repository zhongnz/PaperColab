"""Real browser persistence and conflict recovery; no automatic merge."""
from pathlib import Path
import sys, tempfile
from http.server import ThreadingHTTPServer
from threading import Thread
from shutil import which
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from server.service import Service
from server.http_app import Api
from server.__main__ import make_handler

def run(browser,url):
    context=browser.new_context()
    a=context.new_page()
    b=browser.new_page()
    errors=[]
    for page in (a,b):
        page.on("pageerror",lambda e:errors.append(str(e)))
        page.goto(url)
        page.get_by_role("button",name="Estuary field notes · lead",exact=True).click()
        expect(page.locator('#blocks button[data-kind="paragraph"]').first).to_be_visible()
    a.get_by_role("checkbox",name="Keep drafts on this browser").check()
    p=a.get_by_role("textbox",name="Visual block text")
    p.click();p.press("Control+Home");a.keyboard.insert_text("Recovered local ")
    expect(a.locator("#draft-storage-status")).to_have_text("Draft stored on this browser.")
    a.on("dialog",lambda dialog:dialog.accept())
    a.reload()
    a.get_by_role("button",name="Estuary field notes · lead",exact=True).click()
    expect(a.locator("#local-recovery")).to_be_visible()
    q=b.get_by_role("textbox",name="Visual block text")
    q.click();q.press("Control+Home");b.keyboard.insert_text("Remote ")
    b.get_by_role("button",name="Save cell directly").click()
    expect(b.locator("#status")).to_contain_text("saved via direct")
    expect(p).to_contain_text("Remote",timeout=12000)
    a.get_by_role("button",name="Show stored drafts").click()
    saved=a.locator("#recovery-list button")
    expect(saved).to_have_count(1)
    saved.click()
    expect(a.locator("#recovery-note")).to_contain_text("Conflict")
    expect(a.locator("#recovery-base")).not_to_contain_text("Remote")
    expect(a.locator("#recovery-local")).to_contain_text("Recovered local")
    expect(a.locator("#recovery-remote")).to_contain_text("Remote")
    # A second remote edit makes the comparison stale; it cannot overwrite.
    q.click();q.press("Control+Home");b.keyboard.insert_text("Second ")
    b.get_by_role("button",name="Save cell directly").click()
    expect(q).to_contain_text("Second")
    expect(p).to_contain_text("Second",timeout=12000)
    # The view refresh may close comparison; reopen if so, then test manual resolution.
    a.get_by_role("button",name="Show stored drafts").click()
    expect(saved).to_have_count(1)
    saved.click()
    expect(a.locator("#recovery-remote")).to_contain_text("Second")
    area=a.locator("#recovery-result")
    area.fill(a.locator("#recovery-remote").inner_text().replace("Second ","Reconciled "))
    a.get_by_role("button",name="Save reconciled cell").click()
    expect(a.locator("#status")).to_contain_text("Reconciled cell saved")
    expect(q).to_contain_text("Reconciled",timeout=12000)
    expect(a.locator("#recovery-list")).to_contain_text("No stored drafts")
    assert not errors,errors
    context.close();b.close()

if __name__=="__main__":
    with tempfile.TemporaryDirectory() as tmp:
        service=Service(Path(tmp)/"trial.sqlite",demo=True)
        server=ThreadingHTTPServer(("127.0.0.1",0),make_handler(Api(service)))
        thread=Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            with sync_playwright() as pw:
                browser=pw.chromium.launch(executable_path=which("google-chrome") or which("chromium"))
                run(browser,"http://127.0.0.1:"+str(server.server_address[1]))
                browser.close()
        finally:
            server.shutdown();server.server_close();thread.join();service.close()
    print("Local draft recovery browser test passed.")
