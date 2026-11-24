import base64
import io
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch
import zipfile
from server.service import Service
from server.preview import Preview,decode_bundle


def bundle(items):
    out=io.BytesIO()
    with zipfile.ZipFile(out,"w") as z:
        for name,data in items:z.writestr(name,data)
    return out.getvalue()


class PreviewTests(unittest.TestCase):
    def test_bounded_data_only_bundle(self):
        png=b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"+struct.pack(">II",100,100)+b"\x00"*9
        value=decode_bundle(bundle([("document.pdf",b"%PDF-1.7"),("page-1.png",png)]))
        self.assertEqual(base64.b64decode(value["pages"][0]),png)
        for items in [[("document.pdf",b"not pdf")],[("document.pdf",b"%PDF-1.7"),("active.html",b"<script>")],
                      [("document.pdf",b"%PDF-1.7"),("page-1.png",b"not png")]]:
            with self.assertRaises(ValueError):decode_bundle(bundle(items))

    def test_snapshot_permission_and_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            s=Service(Path(tmp)/"demo.sqlite",demo=True)
            try:
                ada=s.actor_by_token("demo-ada")
                project=s.projects(ada)[0]["id"]
                rev=s.manuscript_revision(ada,project)["revision"]
                request=json.dumps({"root":"estuary/main.tex","engine":"pdflatex","revision":rev}).encode()
                auth={"authorization":"Bearer demo-ada"}
                p=Preview(s,True)
                self.assertEqual(Preview(s).handle(project,auth,request)[0],404)
                self.assertEqual(p.handle(project,{},request)[0],401)
                self.assertEqual(p.handle(project,{"authorization":"Bearer demo-quill"},request)[0],403)
                self.assertEqual(p.handle(project,auth,json.dumps({"root":"estuary/main.tex","engine":"other","revision":rev}).encode())[0],400)
                with patch("server.preview.compile_bundle") as worker:
                    def build(archive,root,engine):
                        self.assertTrue(s.lock.acquire(blocking=False))
                        s.lock.release()
                        with zipfile.ZipFile(io.BytesIO(archive)) as z:self.assertIn(root,z.namelist())
                        return {"pdf_b64":"fixture","pdf_sha256":"fixture","pages":[]}
                    worker.side_effect=build
                    self.assertEqual(p.handle(project,auth,request)[1]["status"],"succeeded")
                    p.slot.acquire()
                    try:self.assertEqual(p.handle(project,auth,request)[0],429)
                    finally:p.slot.release()
                    self.assertEqual(p.handle(project,auth,json.dumps({"root":"estuary/main.tex","engine":"pdflatex","revision":rev+1}).encode())[0],409)
                    self.assertEqual(worker.call_count,1)
                    def revoke(archive,root,engine):
                        with s.lock:s.remove_member(ada,project,s.actor_by_token("demo-bao")["id"])
                        return {"pdf_b64":"fixture","pdf_sha256":"fixture","pages":[]}
                    worker.side_effect=revoke
                    self.assertEqual(p.handle(project,{"authorization":"Bearer demo-bao"},request)[0],403)
            finally:s.close()
