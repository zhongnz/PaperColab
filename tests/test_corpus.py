import gzip
import io
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "corpus"))
from pack import pack


class CorpusTests(unittest.TestCase):
    def test_tar_preserves_relative_paths_and_exact_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            src, dst = Path(tmp) / "source", Path(tmp) / "paper.zip"
            original = {"./main.tex": b"\\documentclass{article}\r\n", "figs/sample.bin": bytes(range(256))}
            with tarfile.open(src, "w:gz") as tar:
                for name, data in original.items():
                    info = tarfile.TarInfo(name)
                    info.size = len(data)
                    tar.addfile(info, io.BytesIO(data))
            pack(src, dst)
            with zipfile.ZipFile(dst) as z:
                self.assertEqual(z.read("main.tex"), original["./main.tex"])
                self.assertEqual(z.read("figs/sample.bin"), original["figs/sample.bin"])

    def test_single_source_matches_the_input_and_existing_output_survives(self):
        with tempfile.TemporaryDirectory() as tmp:
            src, dst = Path(tmp) / "source", Path(tmp) / "paper.zip"
            data = b"\\documentclass{article}\r\n% untouched \xff\r\n"
            src.write_bytes(gzip.compress(data))
            pack(src, dst)
            with zipfile.ZipFile(dst) as z:
                self.assertEqual(z.read("main.tex"), data)
            with self.assertRaises(FileExistsError):
                pack(src, dst)
            self.assertTrue(dst.exists())

    def test_non_source_and_unsafe_paths_leave_no_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            src, dst = Path(tmp) / "source", Path(tmp) / "paper.zip"
            src.write_bytes(b"%PDF-placeholder")
            with self.assertRaises(ValueError):
                pack(src, dst)
            self.assertFalse(dst.exists())
            with tarfile.open(src, "w:gz") as tar:
                tar.addfile(tarfile.TarInfo("../main.tex"), io.BytesIO())
            with self.assertRaises(ValueError):
                pack(src, dst)
            self.assertFalse(dst.exists())


if __name__ == "__main__":
    unittest.main()
