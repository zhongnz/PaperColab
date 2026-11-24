"""Build an authorized manuscript snapshot in a disposable TeX sandbox."""

from base64 import b64encode
from dataclasses import dataclass
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from threading import BoundedSemaphore
import uuid

from scripts.build_worker import ENGINES, MIB
from scripts.check_build import WORKER, clean_log, command as docker_command


BUILD_TIMEOUT = 45
BUILD_SLOT = BoundedSemaphore(1)


def native_command(root, engine):
    args = ["bwrap", "--unshare-user", "--unshare-ipc", "--unshare-pid", "--unshare-net", "--unshare-uts",
            "--disable-userns", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
            "--uid", "65534", "--gid", "65534", "--clearenv",
            "--ro-bind", "/usr/bin", "/usr/bin", "--ro-bind", "/usr/lib", "/usr/lib",
            "--symlink", "usr/lib", "/lib", "--symlink", "usr/bin", "/bin"]
    for path in ("/usr/lib64", "/lib64", "/usr/share/texlive", "/usr/share/texmf", "/usr/share/fonts",
                 "/etc/texmf", "/etc/fonts", "/etc/ld.so.cache", "/etc/alternatives/bibtex", "/var/lib/texmf"):
        args.extend(("--ro-bind-try", path, path))
    return [*args, "--dev", "/dev", "--size", str(64 * MIB), "--tmpfs", "/tmp",
            "--size", str(384 * MIB), "--tmpfs", "/work", "--chdir", "/work",
            "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", "/tmp", "--setenv", "TMPDIR", "/tmp",
            "--setenv", "LC_ALL", "C.UTF-8", "--setenv", "PAPERCOLAB_CONTAINER", "1",
            "--setenv", "PAPERCOLAB_NATIVE_PREVIEW", "1", "--",
            "/usr/bin/python3", "-I", "-c", WORKER.read_text(encoding="utf-8"), root, engine]


def runner_for(engine):
    preferred = os.environ.get("PAPERCOLAB_PDF_RUNNER", "auto")
    if preferred in {"auto", "bubblewrap"} and shutil.which("bwrap") and Path("/usr/bin", engine).is_file():
        return "bubblewrap"
    if preferred in {"auto", "docker"} and shutil.which("docker"):
        return "docker"
    return None


def _cleanup_docker(name):
    try:
        subprocess.run(["docker", "rm", "--force", name], stdin=subprocess.DEVNULL,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, check=False)
    except (OSError, subprocess.SubprocessError):
        pass


@dataclass(frozen=True)
class PreviewJob:
    archive: bytes
    root: str
    revision: int
    draft_count: int
    engine: str

    def resolve(self):
        if not isinstance(self.engine, str) or self.engine not in ENGINES:
            return 400, {"error": "Choose pdfLaTeX, XeLaTeX or LuaLaTeX."}
        if len(self.archive) > 64 * MIB:
            return 413, {"error": "The source ZIP exceeds the 64 MiB preview limit."}
        runner = runner_for(self.engine)
        if runner is None:
            return 503, {"error": "PDF compilation is unavailable on this workspace. You can still open the manuscript preview."}
        if not BUILD_SLOT.acquire(blocking=False):
            return 429, {"error": "Another manuscript is compiling. Try again when that build finishes."}
        try:
            return self._compile(runner)
        finally:
            BUILD_SLOT.release()

    def _compile(self, runner):
        docker = runner == "docker"
        name = "papercolab-preview-" + uuid.uuid4().hex
        with tempfile.TemporaryFile() as pdf, tempfile.TemporaryFile() as diagnostics:
            try:
                args = docker_command(name, self.root, self.engine) if docker else native_command(self.root, self.engine)
                result = subprocess.run(args, input=self.archive, stdout=pdf, stderr=diagnostics,
                                        timeout=BUILD_TIMEOUT, check=False)
            except subprocess.TimeoutExpired:
                if docker:
                    _cleanup_docker(name)
                return 504, {"error": f"The PDF build exceeded {BUILD_TIMEOUT} seconds."}
            except OSError:
                return 503, {"error": "The isolated TeX compiler could not start."}

            if result.returncode:
                size = diagnostics.seek(0, os.SEEK_END)
                diagnostics.seek(max(0, size - 8000))
                reason = clean_log(diagnostics.read()).strip()
                unavailable = reason.startswith(("bwrap:", "docker:"))
                return (503 if unavailable else 422), {
                    "error": "The isolated TeX compiler could not start." if unavailable else "TeX could not compile the manuscript.",
                    "diagnostics": reason,
                }

            size = pdf.tell()
            pdf.seek(0)
            if not 5 < size <= 64 * MIB or pdf.read(5) != b"%PDF-":
                return 422, {"error": "The TeX job did not return a valid PDF."}
            pdf.seek(0)
            return 200, {"pdf_b64": b64encode(pdf.read()).decode("ascii"), "root": self.root,
                         "revision": self.revision, "draft_count": self.draft_count, "engine": self.engine}
