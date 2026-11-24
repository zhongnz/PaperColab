"""Actual loopback HTTP integration test; run after isolated npm install."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from http.server import ThreadingHTTPServer
from threading import Thread
from urllib.request import Request, urlopen
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from server.service import Service
from server.http_app import Api
from server.__main__ import make_handler


class Transport(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "trial.sqlite"
        self.start(True)

    def start(self, enabled):
        self.service = Service(self.path, demo=True, crdt=enabled)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(Api(self.service)))
        self.thread = Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = "http://127.0.0.1:" + str(self.server.server_address[1])

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.service.close()

    def tearDown(self):
        self.stop()
        self.tmp.cleanup()

    def request(self, route, token="demo-bao", body=None, expected=200):
        req = Request(self.url + route, data=None if body is None else json.dumps(body).encode(),
                      headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
        try:
            with urlopen(req, timeout=15) as response:
                status, data = response.status, json.load(response)
        except HTTPError as error:
            status, data = error.code, json.load(error)
        self.assertEqual(status, expected, data)
        return data

    def update(self, state, **kwargs):
        result = subprocess.run(["node", str(ROOT / "experiments/crdt/client_fixture.mjs")],
                                input=json.dumps({**state, **kwargs}), text=True,
                                capture_output=True, check=True, timeout=5)
        return {"version": state["version"], "epoch": state["epoch"], "update": result.stdout}

    def test_checkpoint_transport(self):
        project = self.request("/api/projects")[0]["id"]
        route = "/api/projects/" + project
        detail = self.request(route)
        block = next(b for b in detail["blocks"] if b["rich"] and "two readings" in b["quote"])
        endpoint = route + "/blocks/" + block["stableId"] + "/crdt"
        self.request(endpoint, token="invalid", expected=401)
        self.request(endpoint, token="demo-quill", expected=403)
        self.request(endpoint, token="demo-iris", expected=403)
        before = self.request(endpoint)
        self.assertEqual(before, self.request(endpoint, token="demo-ada"))
        first = self.update(before, old="two readings", next="three readings")
        competing = self.update(before, old="two readings", next="five readings")
        for bad in ({"update": "not base64"}, self.update(before, extra=True),
                    self.update(before, format=True), self.update(before, missing=True)):
            self.request(endpoint, body={**first, **bad}, expected=400)
        self.request(endpoint, body=self.update(before, old="two readings", next="two readings\n\nExtra."),
                     expected=409)
        self.assertEqual(before, self.request(endpoint))
        self.request(endpoint, token="demo-quill", body=first, expected=403)
        accepted = self.request(endpoint, body=first)
        self.assertEqual(accepted["block"]["version"], before["version"]+1)
        self.assertIn("three readings", accepted["block"]["quote"])
        self.request(endpoint, body=competing, expected=409)
        self.request(endpoint, body=first, expected=409)
        checkpoint = self.request(endpoint)
        self.assertEqual(checkpoint["snapshot"], accepted["snapshot"])
        self.assertEqual(checkpoint["epoch"], before["epoch"])
        self.stop()
        self.start(True)
        self.assertEqual(checkpoint, self.request(endpoint))
        second = self.update(checkpoint, old="three readings", next="four readings")
        self.request(endpoint, body=second)
        changed = self.request(endpoint)
        self.assertIn("four readings", changed["quote"])
        self.request(route + "/blocks/" + block["stableId"] + "/edit",
                     body={"version": changed["version"], "before": changed["quote"],
                           "after": changed["quote"].replace("four readings", "six readings"), "mode": "source"})
        fresh = self.request(endpoint)
        self.assertNotEqual(fresh["epoch"], changed["epoch"])
        self.request(endpoint, body=self.update(changed, old="four readings", next="seven readings"), expected=409)
        self.assertIn("six readings", self.request(endpoint)["quote"])
        self.stop()
        self.start(False)
        self.request(endpoint, expected=404)


if __name__ == "__main__":
    unittest.main()
