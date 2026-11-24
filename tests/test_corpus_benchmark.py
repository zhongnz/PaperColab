import csv
import json
from pathlib import Path
import tempfile
import subprocess
import shutil
import zipfile
import unittest
from corpus.benchmark import MANIFEST, root_for, marker_present, valid_source, build_diagnostic
from corpus.summarize import summarize


class CorpusBenchmarkTests(unittest.TestCase):
    def test_root_selection_and_pinned_urls(self):
        report={"roots":[{"root":"main.tex"},{"root":"supplement.tex"}]}
        self.assertIsNone(root_for(report))
        self.assertEqual(root_for(report,"supplement.tex"),{"root":"supplement.tex"})
        self.assertIsNone(root_for(report,"missing.tex"))
        self.assertTrue(valid_source("https://arxiv.org/src/1706.03762v1"))
        for url in ("https://arxiv.org/src/1706.03762","https://example.org/src/1706.03762v1",
                    "https://arxiv.org/src/1706.03762v1?x=1","http://arxiv.org/src/1706.03762v1"):
            self.assertFalse(valid_source(url))
        self.assertTrue(marker_present("PaperColab round-\ntrip check."))
        self.assertFalse(marker_present("PaperColab round-trip."))

    def test_gate_rejects_missing_and_unproven_pass(self):
        with MANIFEST.open(encoding="utf-8") as file:papers=list(csv.DictReader(file))
        rows=[{"index":i,"title":p["short_title"],"source":p["pinned_source_url"],
               "status":"acquisition-failed"} for i,p in enumerate(papers,1)]
        summary=summarize(rows,papers)
        self.assertEqual(summary["passed"],0)
        self.assertFalse(summary["gate_met"])
        with self.assertRaises(ValueError):summarize(rows[:-1],papers)
        with self.assertRaises(ValueError):summarize(rows[:-1]+[rows[0]],papers)
        rows[0]["status"]="pass"
        with self.assertRaises(ValueError):summarize(rows,papers)
        for row in rows[:18]:
            row.update(status="pass",baseline="pass",roundtrip="pass",edited_build="pass",
                       coverage={"editableParagraphs":1,"fallbackParagraphs":3},
                       root="main.tex",edit_target="main.tex",pdf_marker_verified=True,compiler_image_verified=True,
                       baseline_pdf_sha256="a"*64,edited_zip_sha256="b"*64,
                       edited_pdf_sha256="c"*64,zip_sha256="d"*64)
        summary=summarize(rows,papers)
        self.assertTrue(summary["gate_met"])
        self.assertEqual(summary["paragraph_coverage"],0.25)

    @unittest.skipUnless(shutil.which("node"),"Node required for shared editor benchmark")
    def test_multifile_roundtrip(self):
        repo=MANIFEST.parents[1]
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp)
            source,edited=base/"source.zip",base/"edited.zip"
            root=b"\\documentclass{article}\n\\begin{document}\n\\input{sections/methods}\n\\end{document}\n"
            methods=b"Original observation.\\n\\nAnother paragraph.\\n".replace(b"\\n",b"\n")
            with zipfile.ZipFile(source,"w") as z:
                z.writestr("main.tex",root)
                z.writestr("sections/methods.tex",methods)
                z.writestr("unrelated.tex",b"Do not edit.")
                z.writestr("figure.bin",b"\x00\xff\x01")
            def call(*args):
                proc=subprocess.run(["node",*map(str,args)],cwd=repo,capture_output=True,text=True,timeout=30)
                self.assertEqual(proc.returncode,0,proc.stderr)
                return proc.stdout
            target=json.loads(call("corpus/target.cjs",source,"main.tex"))["target"]
            self.assertEqual(target,"sections/methods.tex")
            call("corpus/roundtrip.cjs",source,"main.tex",edited,target)
            with zipfile.ZipFile(edited) as z:
                self.assertEqual(z.read("main.tex"),root)
                self.assertEqual(z.read("sections/methods.tex"),methods.replace(b"Original observation.",b"Original observation. PaperColab round-trip check."))
                self.assertEqual(z.read("unrelated.tex"),b"Do not edit.")
                self.assertEqual(z.read("figure.bin"),b"\x00\xff\x01")
            bad=subprocess.run(["node","corpus/roundtrip.cjs",str(source),"main.tex",str(base/"bad.zip"),"unrelated.tex"],
                               cwd=repo,capture_output=True,text=True,timeout=30)
            self.assertNotEqual(bad.returncode,0)

    def test_build_diagnostics_do_not_return_log_content(self):
        cases=[
            ("I couldn't open database file confidential.bib","missing-bibliography-data"),
            ("! LaTeX Error: File confidential.sty not found.","missing-file"),
            ("Package fontspec Error: requires XeLaTeX","font-or-engine"),
            ("Undefined control sequence.","undefined-control-sequence"),
            ("Build interrupted or exceeded the 120-second limit.","resource-or-time-limit"),
            ("some manuscript content","unclassified")]
        for message,expected in cases:
            self.assertEqual(build_diagnostic(message),expected)
