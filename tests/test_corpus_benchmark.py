import csv
import json
from pathlib import Path
import tempfile
import unittest
from corpus.benchmark import MANIFEST, root_for, marker_present, valid_source
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
                       edited_pdf_sha256="fixture",zip_sha256="fixture")
        summary=summarize(rows,papers)
        self.assertTrue(summary["gate_met"])
        self.assertEqual(summary["paragraph_coverage"],0.25)
