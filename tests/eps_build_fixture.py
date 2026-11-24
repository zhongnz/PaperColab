"""Real isolated container regression for EPS recovery and shipped bibliography."""
from pathlib import Path
import io
import subprocess
import sys
import tempfile
import zipfile

ROOT=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as tmp:
    archive=Path(tmp)/"fixture.zip"
    pdf=Path(tmp)/"fixture.pdf"
    with zipfile.ZipFile(archive,"w") as z:
        z.writestr("main.tex",r"\documentclass{article}\usepackage{graphicx}\begin{document}See \cite{known}.\includegraphics[width=2cm]{figures/plot.eps}\bibliographystyle{plain}\bibliography{unavailable}\end{document}")
        z.writestr("main.bbl",r"\begin{thebibliography}{1}\bibitem{known} A. Author. Supplied reference.\end{thebibliography}")
        z.writestr("figures/plot.eps","%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 100 100\nnewpath 10 10 moveto 90 90 lineto stroke\nshowpage\n%%EOF\n")
    result=subprocess.run([sys.executable,str(ROOT/"scripts/check_build.py"),"--root","main.tex","--pdf",str(pdf),str(archive)],
                          capture_output=True,text=True,check=True)
    assert '"eps_converted":1' in result.stdout,result.stdout
    assert '"bibliography":"supplied-bbl"' in result.stdout,result.stdout
    assert pdf.read_bytes().startswith(b"%PDF-")
    text=subprocess.check_output(["pdftotext",str(pdf),"-"],text=True)
    assert "Supplied reference" in text,text
    assert "[?]" not in text,text
print("Isolated EPS and supplied bibliography fixture passed.")
