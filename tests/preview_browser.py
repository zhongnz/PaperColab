"""Real Docker-backed PDF preview via hosted UI (isolated-pdf CI)."""
import base64
from http.server import ThreadingHTTPServer
from pathlib import Path
from shutil import which
import sys
import tempfile
from threading import Thread
from playwright.sync_api import sync_playwright,expect

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from server.service import Service
from server.http_app import Api
from server.__main__ import make_handler

with tempfile.TemporaryDirectory() as tmp:
    service=Service(Path(tmp)/"paper.sqlite",demo=True)
    server=ThreadingHTTPServer(("127.0.0.1",0),make_handler(Api(service,preview=True)))
    thread=Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
        with sync_playwright() as pw:
            browser=pw.chromium.launch(executable_path=which("google-chrome") or which("chromium"))
            page=browser.new_page()
            page.goto("http://127.0.0.1:"+str(server.server_address[1]))
            page.get_by_role("button",name="Estuary field notes · lead").click()
            expect(page.locator("#compile-preview")).to_be_enabled()
            page.locator("#compile-preview").click()
            expect(page.locator("#download-preview")).to_be_visible(timeout=150000)
            expect(page.locator("#preview-pages img").first).to_be_visible(timeout=150000)
            assert page.locator("#preview-pages img").first.evaluate("(img)=>img.complete && img.naturalWidth>0")
            with page.expect_download() as dl:page.locator("#download-preview").click()
            assert Path(dl.value.path()).read_bytes().startswith(b"%PDF-")
            page.locator("#clear-preview").click()
            expect(page.locator("#preview-pages img")).to_have_count(0)
            browser.close()
    finally:
        server.shutdown();server.server_close();thread.join();service.close()
print("Real local Docker PDF preview browser flow passed.")
