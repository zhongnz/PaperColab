"""Browser identity and project access checks for hosted workspaces."""

from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from server.__main__ import bootstrap_operator
from server.access import INVITE_AGE, SESSION_AGE, WithHeaders
from server.http_app import Api
from server.service import Service
from server.transport import dispatch
from server.wsgi import read_response


ORIGIN = "https://papercolab.example"


class AccessTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.data = Path(directory.name)
        self.now = 100_000
        self.service = Service(self.data / "test.sqlite", clock=lambda: self.now)
        self.addCleanup(self.service.close)
        self.api = Api(self.service, secure=True, public_origin=ORIGIN)
        self.operator_key = "operator-test-key-for-the-test-workspace"
        bootstrap_operator(self.service, self.data, self.operator_key)
        operator = self.service.actor_by_token(self.operator_key)
        self.project = self.service.create_project(operator, "A private manuscript")["id"]
        self.invite_url = f"/api/projects/{self.project}/invitations"

    def request(self, method, path, data=None, *, cookie=None, bearer=None, origin=ORIGIN):
        headers = {"host": "papercolab.example"}
        if origin:
            headers["origin"] = origin
        if cookie:
            headers["cookie"] = cookie
        if bearer:
            headers["authorization"] = f"Bearer {bearer}"
        if data is not None:
            headers["content-type"] = "application/json"
        return self.api.handle(method, path, headers, json.dumps(data).encode() if data is not None else b"")

    def sign_in(self, key):
        status, response = self.request("POST", "/api/session", {"token": key})
        self.assertEqual(status, 200)
        self.assertIsInstance(response, WithHeaders)
        self.assertIn("HttpOnly", response.headers["Set-Cookie"])
        self.assertIn("; Secure", response.headers["Set-Cookie"])
        return response.headers["Set-Cookie"].split(";")[0]

    def invite(self, role="author"):
        status, payload = self.request("POST", self.invite_url, {"role": role}, bearer=self.operator_key)
        self.assertEqual(status, 200)
        return payload

    def redeem(self, invitation, name="Coauthor", **headers):
        return self.request("POST", "/api/invitations/redeem", {"code": invitation["code"], "name": name}, **headers)

    def test_single_use_invite_creates_person_and_recovery_key(self):
        invite = self.invite("reviewer")
        status, joined = self.redeem(invite)
        self.assertEqual(status, 200)
        self.assertEqual(joined.payload["project_id"], self.project)
        cookie = joined.headers["Set-Cookie"].split(";")[0]
        _, member = self.request("GET", "/api/me", cookie=cookie)
        self.assertEqual(member["name"], "Coauthor")
        _, projects = self.request("GET", "/api/projects", cookie=cookie)
        self.assertEqual([p["role"] for p in projects], ["reviewer"])
        status, _ = self.request("POST", self.invite_url, {"role": "reader"}, cookie=cookie)
        self.assertEqual(status, 403)
        self.assertEqual(self.redeem(invite)[0], 404)
        new_cookie = self.sign_in(joined.payload["recovery_key"])
        _, member_from_key = self.request("GET", "/api/me", cookie=new_cookie)
        self.assertEqual(member["id"], member_from_key["id"])

    def test_expired_and_cancelled_invites_and_sessions(self):
        cookie = self.sign_in(self.operator_key)
        expired = self.invite()
        self.now += INVITE_AGE
        self.assertEqual(self.redeem(expired)[0], 404)
        cancelled = self.invite()
        self.assertEqual(self.request("DELETE", f"{self.invite_url}/{cancelled['id']}", cookie=cookie)[0], 200)
        self.assertEqual(self.redeem(cancelled)[0], 404)
        self.now += SESSION_AGE
        self.assertEqual(self.request("GET", "/api/me", cookie=cookie)[0], 401)

    def test_cross_origin_and_session_logout(self):
        cookie = self.sign_in(self.operator_key)
        for origin in (None, "https://unrelated.example"):
            status, _ = self.request("POST", self.invite_url, {"role": "author"}, cookie=cookie, origin=origin)
            self.assertEqual(status, 403)
        response = self.request("DELETE", "/api/session", cookie=cookie)
        self.assertEqual(response[0], 200)
        self.assertIn("Max-Age=0", response[1].headers["Set-Cookie"])
        self.assertEqual(self.request("GET", "/api/me", cookie=cookie)[0], 401)
        self.assertEqual(self.request("GET", "/api/me", bearer=self.operator_key)[0], 200)

    def test_a_tab_cannot_use_a_replacement_session_as_the_previous_actor(self):
        invite = self.invite()
        _, joined = self.redeem(invite)
        cookie = joined.headers["Set-Cookie"].split(";")[0]
        old_id = self.service.actor_by_token(self.operator_key)["id"]
        status, _ = self.api.handle("GET", "/api/projects", {"cookie": cookie, "x-papercolab-actor": old_id}, b"")
        self.assertEqual(status, 409)
        self.assertEqual(self.request("GET", "/api/projects", cookie=cookie)[0], 200)

    def test_wsgi_rejects_oversize_and_transports_secure_session(self):
        payload = json.dumps({"token": self.operator_key}).encode()
        environ = {"REQUEST_METHOD": "POST", "PATH_INFO": "/api/session", "CONTENT_TYPE": "application/json",
                   "CONTENT_LENGTH": str(len(payload)), "HTTP_ORIGIN": ORIGIN, "wsgi.input": io.BytesIO(payload)}
        status, _, headers = read_response(self.api, environ)
        self.assertEqual(status, 200)
        self.assertIn("; Secure", dict(headers)["Set-Cookie"])
        environ["CONTENT_LENGTH"] = str(65 * 1024 * 1024)
        self.assertEqual(read_response(self.api, environ)[0], 413)

    def test_preview_snapshots_under_lock_and_builds_outside_it(self):
        project = self.service.create_project(self.service.actor_by_token(self.operator_key), "Preview", starter=True)
        target = f"/api/projects/{project['id']}/preview"
        headers = {"authorization": f"Bearer {self.operator_key}", "content-type": "application/json"}

        def build(snapshot):
            self.assertFalse(self.service.lock.locked())
            self.assertEqual(snapshot.root, "main.tex")
            self.assertEqual(snapshot.revision, project["revision"])
            self.assertTrue(snapshot.archive.startswith(b"PK"))
            return 200, {"built": True}

        with patch("server.preview.PreviewJob.resolve", autospec=True, side_effect=build) as resolve:
            self.assertEqual(dispatch(self.api, "POST", target, {}, b"")[0], 401)
            status, response, metadata = dispatch(self.api, "POST", target, headers, b"{}")
            self.assertEqual((status, json.loads(response)), (200, {"built": True}))
            self.assertEqual(dict(metadata)["Cache-Control"], "no-store")
            resolve.assert_called_once()

    def test_local_bootstrap_stores_key_privately(self):
        service = Service(self.data / "fresh.sqlite")
        self.addCleanup(service.close)
        with redirect_stdout(io.StringIO()) as output:
            bootstrap_operator(service, self.data, None)
        key_path = self.data / "operator-token"
        key = key_path.read_text().strip()
        self.assertEqual(key_path.stat().st_mode & 0o777, 0o600)
        self.assertNotIn(key, output.getvalue())
        self.assertEqual(service.actor_by_token(key)["workspace_role"], "operator")


if __name__ == "__main__":
    unittest.main()
