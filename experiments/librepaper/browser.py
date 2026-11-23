from pathlib import Path
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from shutil import which
from threading import Thread
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[2]
with ThreadingHTTPServer(('127.0.0.1', 0), partial(SimpleHTTPRequestHandler, directory=root)) as server, sync_playwright() as pw:
    Thread(target=server.serve_forever, daemon=True).start()
    browser = pw.chromium.launch(executable_path=which('google-chrome') or which('chromium'))
    page = browser.new_page()
    page.on('pageerror', lambda error: print('Browser error:', error, flush=True))
    page.goto(f'http://127.0.0.1:{server.server_port}/experiments/librepaper/demo.html')
    visual, source = (page.locator('article').nth(0), page.locator('article').nth(1))
    prose = visual.locator('.visual-prose')
    code = source.locator('.cm-content')
    expect(prose).to_contain_text('fictional')
    # Interior insertions retain both anchor endpoints.
    prose.click()
    prose.press('Control+Home')
    prose.press('Control+ArrowRight')
    page.keyboard.insert_text('small ')
    visual.get_by_text('Apply edit').click()
    expect(code).to_contain_text('small')
    code.click()
    code.press('Control+Home')
    code.press('Control+ArrowRight')
    page.keyboard.insert_text('tidal ')
    source.get_by_text('Apply edit').click()
    expect(prose).to_contain_text('tidal')
    browser.close()
    server.shutdown()
print('Both real editor panes exchanged edits through LibrePaper.')
