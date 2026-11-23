"""One TeX job inside the disposable verification container. The host sends a ZIP on stdin."""
import io
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile

MIB = 1024 * 1024
ENGINES = {"pdflatex": "-pdf", "xelatex": "-pdfxe", "lualatex": "-pdflua"}


def valid_path(name):
    return (len(name) <= 1024 and not re.search(r"[\\:\x00-\x1f\x7f]", name)
            and all(part not in {"", ".", ".."} for part in name.split("/")))


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
            with archive.open(entry) as source, path.open("xb") as target:
                shutil.copyfileobj(source, target, 64 * 1024)
            if path.stat().st_size != entry.file_size:
                raise ValueError("Incomplete ZIP entry.")


def build(data, root, engine, work):
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
    cmd = ["latexmk", "-norc", "-g", ENGINES[engine], "-interaction=nonstopmode", "-halt-on-error",
           "-file-line-error", "-latexoption=-no-shell-escape", "-outdir=" + str(out), main.name]
    if engine == "lualatex":
        cmd.insert(-1, "-latexoption=--safer")
    env = {**os.environ, "openin_any": "p", "openout_any": "p", "TEXMFOUTPUT": str(out)}
    with log.open("wb") as stream:
        run = subprocess.run(cmd, cwd=main.parent, env=env, stdin=subprocess.DEVNULL,
                             stdout=stream, stderr=subprocess.STDOUT, check=False)
    pdf = out / (main.stem + ".pdf")
    if run.returncode or not pdf.is_file():
        with log.open("rb") as stream:
            # The end of latexmk's log includes its first reported failure and the final engine status.
            stream.seek(max(0, log.stat().st_size - 6000))
            tail = stream.read().decode("utf-8", "replace")
        raise ValueError("TeX build failed.\n" + tail)
    if not 5 < pdf.stat().st_size <= 64 * MIB:
        raise ValueError("PDF is empty or exceeds 64 MiB.")
    contents = pdf.read_bytes()
    if not contents.startswith(b"%PDF-"):
        raise ValueError("The TeX job did not produce a PDF.")
    return contents


if __name__ == "__main__":
    if os.environ.get("PAPERCOLAB_CONTAINER") != "1" or Path.cwd() != Path("/work"):
        raise SystemExit("Start the isolated job with scripts/check_build.py.")
    try:
        with tempfile.TemporaryDirectory(dir="/work") as tmp:
            pdf = build(sys.stdin.buffer.read(64 * MIB + 1), sys.argv[1], sys.argv[2], Path(tmp))
            sys.stdout.buffer.write(pdf)
    except (ValueError, OSError, RuntimeError, zipfile.BadZipFile) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
