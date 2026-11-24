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


def fixed_build(main, out, log, engine, env):
    """Run bounded TeX passes on systems with TeX Live but no latexmk."""
    args = [engine, "-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error",
            "-file-line-error", "-output-directory=" + str(out), "./" + main.name]
    if engine == "lualatex":
        args.insert(1, "--safer")

    def run(command, cwd, variables):
        with log.open("ab") as stream:
            return subprocess.run(command, cwd=cwd, env=variables, stdin=subprocess.DEVNULL,
                                  stdout=stream, stderr=subprocess.STDOUT, check=False).returncode == 0

    if not run(args, main.parent, env):
        return False
    job = main.stem
    if (out / (job + ".bcf")).is_file():
        if not shutil.which("biber"):
            raise ValueError("This manuscript needs Biber to build its bibliography.")
        if not run(["biber", "--input-directory", str(out), "--output-directory", str(out), "./" + job], main.parent, env):
            return False
    else:
        has_bibliography = False
        for path in out.rglob("*.aux"):
            with path.open("rb") as aux:
                if b"\\bibdata{" in aux.read(MIB):
                    has_bibliography = True
                    break
        if has_bibliography:
            bibenv = {**env, "BIBINPUTS": str(main.parent) + ":", "BSTINPUTS": str(main.parent) + ":"}
            if not run(["bibtex", "./" + job], out, bibenv):
                return False
    return run(args, main.parent, env) and run(args, main.parent, env)


def build(data, root, engine, work, *, use_latexmk=True):
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
    env = {**os.environ, "openin_any": "p", "openout_any": "p", "TEXMFOUTPUT": str(out)}
    if use_latexmk:
        cmd = ["latexmk", "-norc", "-g", ENGINES[engine], "-interaction=nonstopmode", "-halt-on-error",
               "-file-line-error", "-latexoption=-no-shell-escape", "-outdir=" + str(out), main.name]
        if engine == "lualatex":
            cmd.insert(-1, "-latexoption=--safer")
        with log.open("wb") as stream:
            succeeded = subprocess.run(cmd, cwd=main.parent, env=env, stdin=subprocess.DEVNULL,
                                       stdout=stream, stderr=subprocess.STDOUT, check=False).returncode == 0
    else:
        succeeded = fixed_build(main, out, log, engine, env)
    pdf = out / (main.stem + ".pdf")
    if not succeeded or not pdf.is_file():
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


def set_preview_limits():
    import resource

    for limit, value in ((resource.RLIMIT_CPU, 20), (resource.RLIMIT_AS, 768 * MIB),
                         (resource.RLIMIT_FSIZE, 64 * MIB), (resource.RLIMIT_CORE, 0)):
        resource.setrlimit(limit, (value, value))


if __name__ == "__main__":
    if os.environ.get("PAPERCOLAB_CONTAINER") != "1" or Path.cwd() != Path("/work"):
        raise SystemExit("Start the isolated job with scripts/check_build.py.")
    try:
        native_preview = os.environ.get("PAPERCOLAB_NATIVE_PREVIEW") == "1"
        if native_preview:
            set_preview_limits()
        with tempfile.TemporaryDirectory(dir="/work") as tmp:
            pdf = build(sys.stdin.buffer.read(64 * MIB + 1), sys.argv[1], sys.argv[2], Path(tmp),
                        use_latexmk=not native_preview or shutil.which("latexmk") is not None)
            sys.stdout.buffer.write(pdf)
    except (ValueError, OSError, RuntimeError, zipfile.BadZipFile) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
