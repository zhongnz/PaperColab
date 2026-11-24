"""One TeX job inside the disposable verification container. The host sends a ZIP on stdin."""
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import shutil
import subprocess
import sys
import tempfile
import zipfile

MIB = 1024 * 1024
ENGINES = {"pdflatex": "-pdf", "xelatex": "-pdfxe", "lualatex": "-pdflua"}


def valid_path(name):
    return (len(name) <= 1024 and not re.search(r"[\\:\x00-\x1f\x7f]", name)
            and all(part not in {"", ".", ".."} for part in name.split("/")))


def copy_bounded(source, target, declared):
    """Copy at most the declared byte count, then reject any further output."""
    if not isinstance(declared, int) or declared < 0:
        raise ValueError("Expanded data exceeds the declared size.")
    remaining = declared
    while remaining:
        chunk = source.read(min(64 * 1024, remaining))
        if not chunk:
            break
        if len(chunk) > remaining:
            raise ValueError("Expanded data exceeds the declared size.")
        target.write(chunk)
        remaining -= len(chunk)
    if source.read(1):
        raise ValueError("Expanded data exceeds the declared size.")


def unpack(data, directory):
    used = set()
    total = 0
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        if len(entries) > 4000:
            raise ValueError("Archive exceeds 4,000 entries.")
        for entry in entries:
            name = re.sub(r"^(?:\./)+", "", entry.orig_filename)
            if not name and entry.is_dir() and entry.orig_filename.startswith("./"):
                continue
            if entry.is_dir():
                name = name.removesuffix("/")
            mode = stat.S_IFMT(entry.external_attr >> 16)
            if not valid_path(name) or name in used:
                raise ValueError("Unsafe or conflicting archive path.")
            if entry.flag_bits & 1 or mode not in {0, stat.S_IFDIR, stat.S_IFREG}:
                raise ValueError("Archive contains an encrypted entry, link or special file.")
            used.add(name)
            total += entry.file_size
            if total > 256 * MIB:
                raise ValueError("Expanded archive exceeds 256 MiB.")
            path = directory / name
            if entry.is_dir():
                path.mkdir(parents=True, exist_ok=True)
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            try:
                with archive.open(entry) as source, path.open("xb") as target:
                    copy_bounded(source, target, entry.file_size)
            except zipfile.BadZipFile as error:
                path.unlink(missing_ok=True)
                raise ValueError("Could not verify " + name + ". (" + str(error) + ")") from None
            except ValueError:
                path.unlink(missing_ok=True)
                raise
            if not path.is_file() or path.stat().st_size != entry.file_size:
                path.unlink(missing_ok=True)
                raise ValueError("Incomplete ZIP entry.")


def eps_candidates(directory):
    # Never use arbitrary TeX-supplied commands or path strings. Convert
    # only ordinary archive members with conventional path components.
    candidates=[]
    for path in sorted(directory.rglob("*.eps")):
        rel=path.relative_to(directory)
        if not path.is_file() or path.is_symlink() or not all(
                re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}",part) for part in rel.parts):
            continue
        dest=path.with_name(path.stem+"-eps-converted-to.pdf")
        if dest.exists():
            continue
        candidates.append((path,dest))
    if len(candidates)>8 or sum(p.stat().st_size for p,_ in candidates)>16*MIB:
        return []
    return candidates


def needs_eps_conversion(log, directory):
    # Positive evidence from latexmk's conversion message or a missing
    # expected epstopdf output, not a generic shell-escape warning.
    with log.open("rb") as stream:
        head=stream.read(128*1024)
        stream.seek(max(0,log.stat().st_size-128*1024))
        tail=stream.read(128*1024)
    text=(head+b"\n"+tail).decode("utf-8","replace")
    for source,dest in eps_candidates(directory):
        relative=dest.relative_to(directory).as_posix()
        if re.search(r"File\s+[\x60'\"]?(?:\./)?"+re.escape(relative)+r"[\x60'\"]?\s+(?:not found|does not exist)",text,re.I) or (
                "Logfile claimed conversion from" in text and relative in text and "Output file does not exist" in text):
            return True
    return False


def convert_eps(directory):
    candidates=eps_candidates(directory)
    if not candidates or not shutil.which("gs"):
        raise ValueError("EPS conversion requires Ghostscript and bounded conventional EPS paths.")
    total=0
    for path,dest in candidates:
        # Fixed invocation, no project command line, no network or mounts.
        # Both PostScript and Ghostscript run inside the existing container.
        args=["gs","-dSAFER","-dBATCH","-dNOPAUSE","-dEPSCrop","-sDEVICE=pdfwrite",
              "-sOutputFile="+str(dest),str(path)]
        try:
            result=subprocess.run(args,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,
                                  stderr=subprocess.DEVNULL,timeout=10,check=False)
        except subprocess.TimeoutExpired:
            raise ValueError("EPS conversion exceeded its time budget.") from None
        if result.returncode or not dest.is_file() or not 5<dest.stat().st_size<=16*MIB:
            raise ValueError("EPS conversion did not produce a bounded PDF.")
        with dest.open("rb") as stream:
            if stream.read(5)!=b"%PDF-":raise ValueError("Invalid converted EPS PDF.")
        total+=dest.stat().st_size
        if total>32*MIB:raise ValueError("Converted EPS files exceed 32 MiB.")
    return len(candidates)


def build(data, root, engine, work, report=None):
    root = re.sub(r"^(?:\./)+", "", root)
    if len(data) > 64 * MIB or engine not in ENGINES or not valid_path(root):
        raise ValueError("Unsupported archive, manuscript path or engine.")
    # latexmk constructs engine command lines internally. Limit the basename it receives.
    if not re.fullmatch(r"[\w][\w .-]*\.(?:tex|ltx)", PurePosixPath(root).name, re.I):
        raise ValueError("Use a .tex or .ltx root with a conventional filename (letters, numbers, spaces, dots, dashes or underscores).")
    src = work / "source"
    out = work / "output"
    src.mkdir()
    out.mkdir()
    unpack(data, src)
    main = src / root
    if not main.is_file():
        raise ValueError("Selected root is missing from the archive.")
    log = work / "build.log"
    supplied_bbl=main.with_suffix(".bbl").is_file() and not any(
        p.is_file() and p.suffix.lower()==".bib" for p in src.rglob("*"))
    if report is not None:
        report.update(bibliography="supplied-bbl" if supplied_bbl else "normal",eps_converted=0)
    cmd = ["latexmk", "-norc", "-g", ENGINES[engine], "-interaction=nonstopmode", "-halt-on-error",
           "-file-line-error", "-latexoption=-no-shell-escape", "-outdir=" + str(out), main.name]
    if supplied_bbl:
        # Explicitly retain a supplied bibliography when the ZIP contains
        # no source .bib. No fabricated references, no ignored errors.
        cmd.insert(-1,"-bibtex-")
    if engine == "lualatex":
        cmd.insert(-1, "-latexoption=--safer")
    env = {**os.environ, "openin_any": "p", "openout_any": "p", "TEXMFOUTPUT": str(out)}
    def compile_once():
        # Some TeX versions need the output counterpart of an include
        # subdirectory before writing that section's .aux.
        for path in main.parent.rglob("*"):
            if path.is_dir() and not path.is_symlink():
                (out/path.relative_to(main.parent)).mkdir(parents=True,exist_ok=True)
        with log.open("wb") as stream:
            return subprocess.run(cmd, cwd=main.parent, env=env, stdin=subprocess.DEVNULL,
                                  stdout=stream, stderr=subprocess.STDOUT, check=False)
    run=compile_once()
    pdf = out / (main.stem + ".pdf")
    if run.returncode and engine=="pdflatex" and needs_eps_conversion(log,main.parent):
        # Restart from the exact input ZIP, not potentially changed or
        # partially generated files. Never publish the generated assets
        # back into the manuscript or source archive.
        shutil.rmtree(src);shutil.rmtree(out)
        src.mkdir();out.mkdir()
        unpack(data,src)
        count=convert_eps(main.parent)
        if report is not None:report["eps_converted"]=count
        run=compile_once()
    if run.returncode or not pdf.is_file():
        # latexmk's tail often contains only a generic status. Retain the
        # first explicit TeX error and a few continuation lines for local
        # diagnosis, without increasing the host log cap or uploading logs.
        first = []
        with log.open("rb") as stream:
            for line in stream:
                if re.search(rb"^(?:! |[^:\r\n]{1,500}:\d+: )",line):
                    first.append(line[:500])
                    for _ in range(3):
                        first.append(stream.readline(500))
                    break
            stream.seek(max(0, log.stat().st_size - 4500))
            tail = stream.read().decode("utf-8", "replace")
        detail = b"".join(first).decode("utf-8","replace")
        raise ValueError("TeX build failed.\n" + detail + "\n" + tail)
    if not 5 < pdf.stat().st_size <= 64 * MIB:
        raise ValueError("PDF is empty or exceeds 64 MiB.")
    contents = pdf.read_bytes()
    if not contents.startswith(b"%PDF-"):
        raise ValueError("The TeX job did not produce a PDF.")
    return contents


def preview_bundle(pdf, work):
    """Rasterise at most three pages inside the same disposable container.

    Never return PDF-generated HTML or SVG. If neither renderer is
    installed or rendering fails, retain the compiled PDF with a
    transparent preview-unavailable result.
    """
    if len(pdf)>16*MIB:
        raise ValueError("PDF exceeds the 16 MiB interactive preview limit. Use the standalone build.")
    source=work/"preview.pdf"
    source.write_bytes(pdf)
    prefix=work/"page"
    if shutil.which("pdftoppm"):
        args=["pdftoppm","-f","1","-l","3","-scale-to","1200","-png",str(source),str(prefix)]
    elif shutil.which("gs"):
        args=["gs","-dSAFER","-dBATCH","-dNOPAUSE","-dFirstPage=1","-dLastPage=3",
              "-sDEVICE=png16m","-dFIXEDMEDIA","-dPDFFitPage","-r100","-g1200x1200",
              "-sOutputFile="+str(prefix)+"-%d.png",str(source)]
    else:
        args=None
    pages=[]
    if args:
        try:
            result=subprocess.run(args,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,
                                  stderr=subprocess.DEVNULL,timeout=20,check=False)
            if result.returncode==0:
                for path in sorted(work.glob("page-*.png"))[:3]:
                    if not path.is_file() or path.stat().st_size>2*MIB:break
                    data=path.read_bytes()
                    if not data.startswith(b"\x89PNG\r\n\x1a\n"):break
                    pages.append(data)
        except (OSError,subprocess.TimeoutExpired):
            pass
    buffer=io.BytesIO()
    with zipfile.ZipFile(buffer,"w",compression=zipfile.ZIP_STORED) as z:
        z.writestr("document.pdf",pdf)
        for i,data in enumerate(pages,1):z.writestr("page-"+str(i)+".png",data)
    return buffer.getvalue()


if __name__ == "__main__":
    if os.environ.get("PAPERCOLAB_CONTAINER") != "1" or Path.cwd() != Path("/work"):
        raise SystemExit("Start the isolated job with scripts/check_build.py.")
    try:
        with tempfile.TemporaryDirectory(dir="/work") as tmp:
            report={}
            try:
                pdf = build(sys.stdin.buffer.read(64 * MIB + 1), sys.argv[1], sys.argv[2], Path(tmp),report)
            finally:
                print("PAPERCOLAB_BUILD_V1 "+json.dumps(report,separators=(",",":")),file=sys.stderr)
            sys.stdout.buffer.write(preview_bundle(pdf,Path(tmp)) if sys.argv[3:]==["preview"] else pdf)
    except (ValueError, OSError, RuntimeError, zipfile.BadZipFile) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
