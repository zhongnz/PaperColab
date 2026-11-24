"""Non-demo local onboarding and project isolation through real browser controls."""
from pathlib import Path
import secrets
import sys
import tempfile
from http.server import ThreadingHTTPServer
from threading import Thread
from shutil import which
from playwright.sync_api import sync_playwright, expect

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from server.service import Service
from server.http_app import Api
from server.__main__ import make_handler


def run(browser,url,operator_token):
    operator=browser.new_page()
    collaborator=browser.new_page()
    errors=[]
    for page in (operator,collaborator):
        page.on("pageerror",lambda e:errors.append(str(e)))
        page.goto(url)
        expect(page.locator("#who")).to_have_text("Signed out")
        expect(page.locator("#demo-account")).not_to_be_visible()
    def sign_in(page,token,name):
        page.locator("#token").fill(token)
        page.get_by_role("button",name="Use token",exact=True).click()
        expect(page.locator("#who")).to_contain_text(name)
        expect(page.locator("#sign-out")).to_be_enabled()
    sign_in(operator,operator_token,"Operator")
    operator.locator("#new-title").fill("Unrelated private project")
    operator.get_by_role("button",name="Create project",exact=True).click()
    expect(operator.locator("#project-title")).to_have_text("Unrelated private project")
    private_id=operator.locator("#project-title").get_attribute("data-id")
    operator.get_by_role("button",name="Open the estuary example").click()
    expect(operator.locator("#project-title")).to_have_text("Estuary field notes")
    expect(operator.locator("#provision-panel")).to_be_visible()
    expect(operator.locator("#provision-account")).to_be_enabled()
    operator.locator("#account-name").fill("Pilot collaborator")
    operator.get_by_role("button",name="Create local account").click()
    expect(operator.locator("#provision-result")).to_be_visible()
    account_id=operator.locator("#provision-id").input_value()
    credential=operator.locator("#provision-token").input_value()
    assert account_id and credential
    expect(operator.locator("#provision-token")).to_have_attribute("type","password")
    operator.get_by_role("checkbox",name="Show access token").check()
    expect(operator.locator("#provision-token")).to_have_attribute("type","text")
    operator.get_by_role("button",name="Clear credential").click()
    expect(operator.locator("#provision-token")).to_have_value("")
    operator.locator('[data-workspace-tab="settings"]').click()
    operator.locator("#member-id").fill(account_id)
    operator.locator("#member-role").select_option("author")
    operator.get_by_role("button",name="Add or update member").click()
    expect(operator.locator("#members")).to_contain_text("Pilot collaborator · human · author")
    sign_in(collaborator,credential,"Pilot collaborator")
    expect(collaborator.locator("#provision-panel")).not_to_be_visible()
    expect(collaborator.locator("#project-list")).not_to_contain_text("Unrelated private project")
    assert collaborator.request.get(url+"/api/projects/"+private_id,headers={"Authorization":"Bearer "+credential}).status==403
    assert collaborator.request.post(url+"/api/admin/actors",headers={"Authorization":"Bearer "+credential},
           data={"name":"Not authorised","kind":"human"}).status==403
    assert collaborator.request.get(url+"/api/health",headers={"Host":"external.example"}).status==403
    assert collaborator.request.get(url+"/api/health",headers={"Origin":"https://external.example"}).status==403
    collaborator.get_by_role("button",name="Estuary field notes · author").click()
    expect(collaborator.locator("#manuscript-panel")).to_be_visible()
    expect(collaborator.locator("#release")).not_to_be_visible()
    collaborator.locator('[data-workspace-tab="settings"]').click()
    expect(collaborator.locator("#membership-form")).not_to_be_visible()
    collaborator.get_by_role("button",name="Sign out",exact=True).click()
    expect(collaborator.locator("#who")).to_have_text("Signed out")
    expect(collaborator.locator("#open")).not_to_be_visible()
    expect(collaborator.locator("#project-list")).to_be_empty()
    expect(collaborator.locator("#members")).to_be_empty()
    assert collaborator.evaluate("sessionStorage.getItem('papercolab-token')") is None
    collaborator.reload()
    expect(collaborator.locator("#who")).to_have_text("Signed out")
    operator.on("dialog",lambda dialog:dialog.accept())
    operator.get_by_role("button",name="Manage local accounts").click()
    operator.get_by_role("button",name="Rotate credential for Pilot collaborator").click()
    expect(operator.locator("#provision-result")).to_be_visible()
    rotated=operator.locator("#provision-token").input_value()
    assert rotated and rotated!=credential
    assert collaborator.request.get(url+"/api/me",headers={"Authorization":"Bearer "+credential}).status==401
    sign_in(collaborator,rotated,"Pilot collaborator")
    expect(collaborator.locator("#project-list")).to_contain_text("Estuary field notes")
    operator.get_by_role("button",name="Revoke account for Pilot collaborator").click()
    expect(operator.locator("#account-list")).to_contain_text("Pilot collaborator · human · revoked")
    assert collaborator.request.get(url+"/api/me",headers={"Authorization":"Bearer "+rotated}).status==403
    assert not errors,errors
    operator.close();collaborator.close()


if __name__=="__main__":
    with tempfile.TemporaryDirectory() as tmp:
        service=Service(Path(tmp)/"paper.sqlite")
        token=secrets.token_urlsafe(24)
        service._insert_actor("Operator","human",token,"operator")
        service.db.commit()
        server=ThreadingHTTPServer(("127.0.0.1",0),make_handler(Api(service)))
        thread=Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            with sync_playwright() as pw:
                browser=pw.chromium.launch(executable_path=which("google-chrome") or which("chromium"))
                run(browser,"http://127.0.0.1:"+str(server.server_address[1]),token)
                browser.close()
        finally:
            server.shutdown();server.server_close();thread.join();service.close()
    print("Non-demo local account onboarding passed.")
