import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from scripts.pilot_check import compare_members, snapshot, check

def make_zip(path,content):
    with zipfile.ZipFile(path,"w") as archive:
        for name,value in content.items():archive.writestr(name,value)

class PilotCheckTests(unittest.TestCase):
    def test_compare_does_not_allow_binary_changes_or_missing_members(self):
        before={"main.tex":"a","figure.pdf":"b","references.bib":"c"}
        self.assertEqual(compare_members(before,{**before,"main.tex":"new"},["main.tex"])["status"],"pass")
        result=compare_members(before,{"main.tex":"new","figure.pdf":"changed","extra.tex":"x"},["main.tex"])
        self.assertEqual(result["status"],"fail")
        self.assertEqual(result["unexpected_changes"],["figure.pdf"])
        self.assertEqual(result["removed_files"],["references.bib"])
        self.assertEqual(result["added_files"],["extra.tex"])
        self.assertEqual(compare_members(before,before,["main.tex"])["status"],"fail")
        for invalid in ([],["figure.pdf"],["unknown.tex"],["../main.tex"]):
            with self.assertRaises(ValueError):compare_members(before,before,invalid)

    def test_snapshot_rejects_traversal_and_keeps_exact_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);original=root/"source.zip"
            make_zip(original,{"main.tex":b"hello\r\n","figure.pdf":b"\x00\xff"})
            before=original.read_bytes()
            copy,hashes=snapshot(original,root/"copy")
            self.assertEqual(copy.read_bytes(),before)
            self.assertEqual(original.read_bytes(),before)
            self.assertEqual(set(hashes),{"main.tex","figure.pdf"})
            bad=root/"bad.zip";make_zip(bad,{"../escape.tex":"bad"})
            with self.assertRaises(ValueError):snapshot(bad,root/"rejected")
            self.assertFalse((root/"rejected/escape.tex").exists())

    @patch("scripts.pilot_check.build")
    @patch("scripts.pilot_check.inspect")
    def test_only_matching_verified_builds_reach_manual_review(self,inspect,build):
        inspect.return_value={"coverage":{"editableParagraphs":1}}
        identity={"status":"pass","image":"fixture","engine":"pdflatex",
                  "profile":{"bibliography":"normal","eps_converted":0},"pdf_sha256":"fixture"}
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);original=root/"a.zip";edited=root/"b.zip"
            make_zip(original,{"main.tex":"Old.","figure.pdf":b"same"})
            make_zip(edited,{"main.tex":"New.","figure.pdf":b"same"})
            baseline=check(original,"main.tex","pdflatex")
            self.assertEqual(baseline["status"],"inspection-only")
            self.assertFalse(baseline["baseline_eligible"])
            build.assert_not_called()
            build.side_effect=[identity,identity]
            result=check(original,"main.tex","pdflatex",edited,["main.tex"],True)
            self.assertEqual(result["status"],"review-required")
            self.assertTrue(result["manual_review_required"])
            build.reset_mock();build.side_effect=[identity,{**identity,"image":"other"}]
            self.assertEqual(check(original,"main.tex","pdflatex",edited,["main.tex"],True)["status"],"blocked")
            build.reset_mock();build.side_effect=[identity]
            make_zip(edited,{"main.tex":"New.","figure.pdf":b"changed"})
            self.assertEqual(check(original,"main.tex","pdflatex",edited,["main.tex"],True)["status"],"blocked")
            self.assertEqual(build.call_count,1)
