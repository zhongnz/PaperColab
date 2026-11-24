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

    def test_declared_size_is_written_in_full(self):
        payload = b"exact bytes\n"
        with tempfile.TemporaryDirectory() as tmp:
            build_worker.unpack(archive([("notes.tex", payload)]), Path(tmp))
            self.assertEqual((Path(tmp) / "notes.tex").read_bytes(), payload)

    def test_copy_stops_at_the_declared_size(self):
        output = io.BytesIO()
        with self.assertRaisesRegex(ValueError, "declared size"):
            build_worker.copy_bounded(io.BytesIO(b"abcdefghij"), output, 4)
        self.assertEqual(output.getvalue(), b"abcd")

    def test_inflated_member_cannot_exceed_its_declared_size(self):
        data = b"A" * 20000
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as zipped:
            zipped.writestr("main.tex", data)
        blob = bytearray(buffer.getvalue())
        declared = (10).to_bytes(4, "little")
        local, central = blob.find(b"PK\x03\x04"), blob.find(b"PK\x01\x02")
        blob[local + 22:local + 26] = declared
        blob[central + 24:central + 28] = declared
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with self.assertRaisesRegex(ValueError, "declared size|Could not verify"):
                build_worker.unpack(bytes(blob), root)
            written = [path.stat().st_size for path in root.rglob("*") if path.is_file()]
            self.assertTrue(all(size <= 10 for size in written))

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

    def test_eps_recovery_requires_positive_matching_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory=Path(tmp)
            (directory/"figures").mkdir()
            (directory/"figures/plot.eps").write_bytes(b"EPS")
            (directory/"figures/bad%name.eps").write_bytes(b"EPS")
            log=directory/"build.log"
            log.write_text("Running pdflatex -no-shell-escape\nShell escape disabled")
            self.assertFalse(build_worker.needs_eps_conversion(log,directory))
            log.write_text("Package pdftex.def Error: File 'figures/plot-eps-converted-to.pdf' not found")
            self.assertTrue(build_worker.needs_eps_conversion(log,directory))
            self.assertEqual(len(build_worker.eps_candidates(directory)),1)
            (directory/"figures/plot-eps-converted-to.pdf").write_bytes(b"supplied")
            self.assertFalse(build_worker.needs_eps_conversion(log,directory))
        self.assertEqual(check_build.build_metadata(b'PAPERCOLAB_BUILD_V1 {"bibliography":"normal","eps_converted":1}\n'),
                         {"bibliography":"normal","eps_converted":1})
        self.assertIsNone(check_build.build_metadata(b'PAPERCOLAB_BUILD_V1 {"bibliography":"normal","eps_converted":99}'))

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

    def test_supplied_bibliography_with_no_database(self):
        data=archive([("main.tex",r"\documentclass{article}\begin{document}See \cite{known}.\bibliographystyle{plain}\bibliography{unavailable}\end{document}"),
                      ("main.bbl",r"\begin{thebibliography}{1}\bibitem{known} A. Author. Supplied reference.\end{thebibliography}")])
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp); report={}
            self.assertTrue(build_worker.build(data,"main.tex","pdflatex",path,report).startswith(b"%PDF-"))
            self.assertEqual(report,{"bibliography":"supplied-bbl","eps_converted":0})
            self.assertIn("Supplied reference",(path/"source/main.bbl").read_text())
            self.assertNotIn("undefined citations",(path/"output/main.log").read_text().lower())

    def test_supplied_bibliography_does_not_hide_missing_citations(self):
        data=archive([("main.tex",r"\documentclass{article}\begin{document}See \cite{unknown}.\bibliographystyle{plain}\bibliography{unavailable}\end{document}"),
                      ("main.bbl",r"\begin{thebibliography}{1}\bibitem{known} A. Author. Supplied reference.\end{thebibliography}")])
        with tempfile.TemporaryDirectory() as tmp,self.assertRaisesRegex(ValueError,"undefined citations"):
            build_worker.build(data,"main.tex","pdflatex",Path(tmp))

    @unittest.skipUnless(shutil.which("gs"),"requires Ghostscript")
    def test_eps_recovery_without_shell_escape(self):
        data=archive([("main.tex",r"\documentclass{article}\usepackage{graphicx}\begin{document}\includegraphics[width=2cm]{figures/plot.eps}\end{document}"),
                      ("figures/plot.eps","%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 100 100\nnewpath 10 10 moveto 90 90 lineto stroke\nshowpage\n%%EOF\n")])
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp); report={}
            pdf=build_worker.build(data,"main.tex","pdflatex",path,report)
            self.assertTrue(pdf.startswith(b"%PDF-"))
            self.assertEqual(report["eps_converted"],1)
            self.assertTrue((path/"source/figures/plot-eps-converted-to.pdf").is_file())
            self.assertNotIn("figures/plot-eps-converted-to.pdf",zipfile.ZipFile(io.BytesIO(data)).namelist())
            self.assertIn("disabled",(path/"output/main.log").read_text().lower())

    def test_missing_section_fails_even_with_stale_pdf(self):
        data = archive([("main.tex", r"\documentclass{article}\begin{document}\input{missing}\end{document}"),
                        ("main.pdf", b"%PDF-1.5 old file")])
        with tempfile.TemporaryDirectory() as tmp, self.assertRaisesRegex(ValueError, "TeX build failed"):
            build_worker.build(data, "main.tex", "pdflatex", Path(tmp))


if __name__ == "__main__":
    unittest.main()
