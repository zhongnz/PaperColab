"""Browser and wire checks for the opt-in streaming revision/presence layer."""
from pathlib import Path
import sys, tempfile, json
from http.server import ThreadingHTTPServer
from threading import Thread
from shutil import which
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from server.service import Service
from server.http_app import Api
from server.__main__ import make_handler


def run(browser, url, service):
    a,b=browser.new_page(),browser.new_page()
    errors=[]
    project=None
    for page, actor, title in ((a,"demo-ada","Estuary field notes · lead"),
                               (b,"demo-bao","Estuary field notes · author")):
        page.on("pageerror",lambda error: errors.append(str(error)))
        page.goto(url)
        page.locator("#actor").select_option(actor)
        expect(page.locator("#who")).to_contain_text("Ada" if page==a else "Bao")
        page.get_by_role("button",name=title,exact=True).click()
        page.get_by_role("checkbox",name="Experimental live collaboration").check()
        expect(page.locator("#live-status")).to_contain_text("connected")
        current_project=page.locator("#project-title").get_attribute("data-id")
        assert current_project, "Connected stream must have a project identity"
        if project is not None:
            assert project==current_project
        project=current_project
        page.locator('#blocks button[data-kind="paragraph"]').first.click()
    expect(a.locator("#presence-list")).to_contain_text("Bao")
    expect(b.locator("#presence-list")).to_contain_text("Ada")
    # A connected client must consume pushed revisions, not revision polling.
    for page in (a,b):
        page.route("**/revision",lambda route: route.abort())
    p=a.get_by_role("textbox",name="Visual block text")
    q=b.get_by_role("textbox",name="Visual block text")
    q.click();q.press("Control+Home");b.keyboard.insert_text("Local draft ")
    expect(a.locator("#presence-list")).to_contain_text("Bao · editing")
    p.click();p.press("Control+Home");a.keyboard.insert_text("Streamed ")
    a.get_by_role("button",name="Save cell directly").click()
    expect(b.locator("#sync-state")).to_contain_text("Your local draft is retained")
    expect(q).to_contain_text("Local draft")
    b.get_by_role("button",name="Discard local draft").click()
    expect(q).to_contain_text("Streamed")
    p.click();p.press("Control+Home");a.keyboard.insert_text("Again ")
    a.get_by_role("button",name="Save cell directly").click()
    expect(q).to_contain_text("Again",timeout=12000)
    # Wire-level unauthenticated and cross-origin requests are denied.
    for headers,status in (({},401),({"Authorization":"Bearer demo-ada","Origin":"https://example.com"},403)):
        try:
            urlopen(Request(url+"/api/projects/"+project+"/live",headers=headers),timeout=5)
            raise AssertionError("unexpected stream access")
        except HTTPError as error:
            assert error.code==status,error.code
    # Permission is checked on an already-open connection as well.
    with service.lock:
        lead=service.actor_by_token("demo-ada")
        bao=service.actor_by_token("demo-bao")
        service.remove_member(lead,project,bao["id"])
    expect(b.locator("#live-status")).to_contain_text("Live access revoked",timeout=12000)
    expect(b.get_by_role("checkbox",name="Experimental live collaboration")).not_to_be_checked()
    expect(a.locator("#presence-list")).not_to_contain_text("Bao",timeout=12000)
    assert not errors,errors
    a.close();b.close()


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
    print("Experimental revision and presence streaming browser test passed.")
