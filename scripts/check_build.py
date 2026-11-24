"""Build one root from an export ZIP with an isolated TeX Live container."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import uuid

IMAGE = "texlive/texlive:TL2025-historic"
WORKER = Path(__file__).with_name("build_worker.py")
MIB = 1024 * 1024


def command(name, root, engine, preview=False):
    return [
        "docker", "run", "--rm", "-i", "--name", name, "--pull=never", "--network=none",
        "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
        "--user=65534:65534", "--cpus=1", "--memory=768m", "--memory-swap=768m", "--pids-limit=128",
        "--tmpfs=/work:rw,noexec,nosuid,nodev,size=384m,mode=1777",
        "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=128m,mode=1777",
        "--workdir=/work", "--env=HOME=/tmp", "--env=PAPERCOLAB_CONTAINER=1",
        "--log-driver=none", "--entrypoint=python3", IMAGE, "-I", "-c", WORKER.read_text(encoding="utf-8"), root, engine,
        *(["preview"] if preview else [])
    ]


def clean_log(raw):
    text = raw.decode("utf-8", "replace")
    return "".join(c for c in text if c in "\n\t" or c.isprintable())


def build_metadata(raw):
    # Worker reports only bounded known fields. Never surface a random
    # manuscript log line as structured execution metadata.
    lines=raw.decode("utf-8","replace").splitlines()
    # The worker emits exactly one record before its error message.
    # A duplicate (including anything impersonated in a TeX log) is not
    # evidence of the actual build profile.
    records=[line for line in lines if line.startswith("PAPERCOLAB_BUILD_V1 ")]
    if len(records)!=1:return None
    for line in records:
        try:
            value=json.loads(line[len("PAPERCOLAB_BUILD_V1 "):])
            if (isinstance(value,dict) and set(value)=={"bibliography","eps_converted"} and
                value["bibliography"] in ("normal","supplied-bbl") and type(value["eps_converted"]) is int and
                0<=value["eps_converted"]<=8):
                return value
        except (ValueError,TypeError):pass
    return None


def verify(archive, root, engine, output):
    if output and output.exists():
        raise ValueError("The requested PDF already exists. Choose a new filename.")
    if not archive.is_file() or not 0 < archive.stat().st_size <= 64 * MIB:
        raise ValueError("Choose a ZIP file between 1 byte and 64 MiB.")
    if not shutil.which("docker"):
        raise ValueError("Docker is required for the isolated build. The browser report remains available.")
    name = "papercolab-" + uuid.uuid4().hex
    with archive.open("rb") as source, tempfile.TemporaryFile() as result:
        try:
            run = subprocess.run(command(name, root, engine), stdin=source, stdout=result,
                                 stderr=subprocess.PIPE, timeout=120, check=False)
        except (subprocess.TimeoutExpired, KeyboardInterrupt):
            subprocess.run(["docker", "rm", "--force", name], capture_output=True, timeout=15, check=False)
            raise ValueError("Build interrupted or exceeded the 120-second limit.") from None
        metadata=build_metadata(run.stderr)
        if metadata:print("PAPERCOLAB_BUILD_V1 "+json.dumps(metadata,separators=(",",":")))
        if run.returncode:
            reason = clean_log(run.stderr[-8000:]).strip()
            raise ValueError(reason or "The container could not finish the build.")
        size = result.tell()
        result.seek(0)
        if not 5 < size <= 64 * MIB or result.read(5) != b"%PDF-":
            raise ValueError("The container did not return a valid PDF header and size.")
        result.seek(0)
        digest = hashlib.file_digest(result, "sha256").hexdigest()
        if output:
            result.seek(0)
            with output.open("xb") as destination:
                try:
                    shutil.copyfileobj(result, destination)
                except BaseException:
                    destination.close()
                    output.unlink(missing_ok=True)
                    raise
        print(f"PDF built with {engine} from {root} ({size:,} bytes).")
        print(f"SHA-256 {digest}")
        if output:
            print(f"Saved to {output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--root", required=True, help="full manuscript path inside the ZIP")
    parser.add_argument("--engine", default="pdflatex", choices=["pdflatex", "xelatex", "lualatex"])
    parser.add_argument("--pdf", type=Path, help="save the newly built PDF under a new filename")
    args = parser.parse_args()
    try:
        verify(args.archive, args.root, args.engine, args.pdf)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(error, file=sys.stderr)
        raise SystemExit(1)
