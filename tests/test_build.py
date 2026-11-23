import io
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch
import warnings
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import build_worker
import check_build
from package import demo_zip


def archive(items):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as z:
        for path, data in items:
            z.writestr(path, data)
    return buffer.getvalue()


class ArchiveTests(unittest.TestCase):
    def test_file_rejection(self):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            archives = [
                archive([("../sample.tex", "text")]),
                archive([("a.tex", "one"), ("a.tex", "two")]),
                archive([("part", "file"), ("part/main.tex", "conflict")]),
            ]
        for data in archives:
            with self.subTest(), tempfile.TemporaryDirectory() as tmp:
                with self.assertRaises((ValueError, OSError)):
                    build_worker.unpack(data, Path(tmp))

    def test_missing_root(self):
        with tempfile.TemporaryDirectory() as tmp, self.assertRaisesRegex(ValueError, "missing"):
            build_worker.build(demo_zip(), "absent.tex", "pdflatex", Path(tmp))

    def test_missing_runtime_fails_without_running_tex(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sample.zip"
            path.write_bytes(demo_zip())
            with patch("check_build.shutil.which", return_value=None), patch("check_build.subprocess.run") as run:
                with self.assertRaisesRegex(ValueError, "Docker is required"):
                    check_build.verify(path, "estuary/main.tex", "pdflatex", None)
                run.assert_not_called()

    def test_readonly_input_and_bounded_container(self):
        args = check_build.command("test-build", "estuary/main.tex", "pdflatex")
        for flag in ["--network=none", "--read-only", "--pull=never", "--user=65534:65534",
                     "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=128"]:
            self.assertIn(flag, args)
        self.assertFalse(any(arg.startswith(("--mount", "--volume")) for arg in args))

    def test_existing_output_survives(self):
        with tempfile.TemporaryDirectory() as tmp:
            pdf = Path(tmp) / "existing.pdf"
            pdf.write_bytes(b"original")
            with self.assertRaisesRegex(ValueError, "already exists"):
                check_build.verify(Path(tmp) / "no.zip", "main.tex", "pdflatex", pdf)
            self.assertEqual(pdf.read_bytes(), b"original")


@unittest.skipUnless(shutil.which("latexmk") and shutil.which("pdflatex"), "requires LaTeX")
class TrustedFixtureBuildTests(unittest.TestCase):
    def test_original_multifile_example_builds_with_bibliography(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)
            self.assertTrue(build_worker.build(demo_zip(), "estuary/main.tex", "pdflatex", path).startswith(b"%PDF-"))
            self.assertIn("fieldguide", (path / "output/main.bbl").read_text())
            self.assertNotIn("undefined references", (path / "output/main.log").read_text())

    def test_missing_section_fails_even_with_stale_pdf(self):
        data = archive([("main.tex", r"\documentclass{article}\begin{document}\input{missing}\end{document}"),
                        ("main.pdf", b"%PDF-1.5 old file")])
        with tempfile.TemporaryDirectory() as tmp, self.assertRaisesRegex(ValueError, "TeX build failed"):
            build_worker.build(data, "main.tex", "pdflatex", Path(tmp))


if __name__ == "__main__":
    unittest.main()
