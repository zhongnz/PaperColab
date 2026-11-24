"""Run the pinned corpus as a diagnostic; never count acquisition/build failure as editor success."""
import argparse
import csv
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import tarfile
import zipfile
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler

from corpus.pack import pack

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "corpus" / "papers.csv"
LIMIT = 64 * 1024 * 1024
MARKER = "PaperColab round-trip check."
IMAGE = "texlive/texlive:TL2025-historic"


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def build_diagnostic(text):
    """Return a fixed diagnostic category, never arbitrary TeX log content."""
    # Ignore latexmk command echoes and normal TeX engine status lines.
    # In the previous run "-no-shell-escape" was misclassified as a
    # shell-escape requirement on all eight failed original builds.
    lines = [line for line in text.lower().splitlines()
             if not re.search(r"^\s*(?:running |command line |latexmk: applying rule|restricted \\write18 enabled|\\write18 disabled|entering extended mode)",line)
             and not re.search(r"^\s*(?:pdflatex|xelatex|lualatex|latexmk)\s",line)]
    text = "\n".join(lines)
    patterns = (
        ("missing-bibliography-data", r"i couldn't open database file|couldn't open style file|bibtex.{0,80}(?:failed|error)|bibliography file .{0,120}(?:not found|missing)|(?:bibtex|biber).{0,100}cannot find"),
        ("missing-file", r"(?:latex|package .{0,80}) error: file .{0,200}not found|i can't find file|file .{0,200}not found"),
        ("shell-escape-required", r"(?:requires?|must (?:enable|use)|need(?:s|ed)?) [^\n]{0,80}(?:shell.escape|write18)|(?:shell.escape|write18) [^\n]{0,60}(?:required|not enabled|must be enabled)|(?:minted|pygmentize)[^\n]{0,120}(?:not installed|not found|disabled)"),
        ("font-or-engine", r"fontspec error|requires.{0,100}(?:xelatex|lualatex)|font .{0,100}not found"),
        ("undefined-control-sequence", r"undefined control sequence"),
        ("tex-input-syntax", r"runaway argument|file ended while scanning|extra \\\\endgroup|missing \\} inserted|emergency stop"),
        ("graphics-format", r"unknown graphics extension|cannot determine size of graphic|error converting .*?\\.(?:eps|pdf)|pdftex error.*?image"),
        ("resource-or-time-limit", r"exceeded the 120-second limit|capacity exceeded|out of memory|oom killed"),
        ("unsafe-archive", r"unsafe or conflicting archive path|special file|unsupported archive|exceeds 256 mib"),
        ("latex-error", r"latex error|package .{0,100} error|fatal error"),
    )
    for code, pattern in patterns:
        if re.search(pattern,text):
            return code
    return "unclassified"


class CommandFailure(RuntimeError):
    def __init__(self, returncode, diagnostic):
        super().__init__("command failed (" + str(returncode) + ")")
        self.diagnostic = diagnostic


def run(args, timeout=180):
    result = subprocess.run(args, cwd=ROOT, capture_output=True, text=True,
                            encoding="utf-8", errors="replace", timeout=timeout)
    if result.returncode:
        raise CommandFailure(result.returncode,build_diagnostic(result.stderr[-32000:]))
    return result.stdout


def valid_source(url):
    parts = urlsplit(url)
    return (parts.scheme == "https" and parts.netloc in {"arxiv.org", "export.arxiv.org"}
            and not parts.query and not parts.fragment
            and re.fullmatch(r"/(?:src|e-print)/\d{4}\.\d{4,5}v\d+", parts.path))


class ArxivRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not valid_source(newurl):
            raise ValueError("Unapproved source redirect.")
        if urlsplit(req.full_url).path.split("/")[-1] != urlsplit(newurl).path.split("/")[-1]:
            raise ValueError("Source redirect changes the pinned version.")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch_source(url, target):
    if not valid_source(url):
        raise ValueError("Expected a pinned arXiv source version.")
    opener = build_opener(ArxivRedirect())
    request = Request(url, headers={"User-Agent": "PaperColab/0.1 manuscript compatibility benchmark",
                                    "Accept": "application/gzip, application/x-tar, application/octet-stream, */*"})
    deadline = time.monotonic() + 90
    try:
        with opener.open(request, timeout=30) as source, target.open("xb") as dest:
            total = 0
            while True:
                if time.monotonic() > deadline:
                    raise ValueError("Source download exceeded time limit.")
                chunk = source.read(65536)
                if not chunk:
                    break
                total += len(chunk)
                if total > LIMIT:
                    raise ValueError("Source exceeds 64 MiB.")
                dest.write(chunk)
            if total == 0:
                raise ValueError("Empty source.")
    except BaseException:
        target.unlink(missing_ok=True)
        raise


def title_words(value):
    return re.findall(r"[^\W_]+",value.casefold(),flags=re.UNICODE)


def root_for(report, override=None, expected_title=None):
    roots = report["roots"]
    if override:
        return next((row for row in roots if row["root"] == override), None)
    if len(roots) == 1:
        return roots[0]
    # Compare against the pre-existing pinned bibliographic title, not
    # filename or best compilation/coverage result. Unique literal title
    # prefix, class and body are all required. Never guess on a tie.
    expected=title_words(expected_title or "")
    if not expected:
        return None
    candidates=[]
    for row in roots:
        evidence=row.get("rootEvidence",{})
        if not evidence.get("hasClass") or not evidence.get("hasBody"):
            continue
        titles=evidence.get("titles",[])
        if len(titles)==1 and title_words(titles[0])[:len(expected)]==expected:
            candidates.append(row)
    return candidates[0] if len(candidates)==1 else None


def marker_present(text):
    # PDF extractors may wrap the hyphenated marker at the line break.
    return MARKER in re.sub(r"round-\s+trip", "round-trip", " ".join(text.split()))


def choose_target(archive, selected):
    # Use the same parser as the editor; do not guess an unreferenced file.
    value = run(["node", "corpus/target.cjs", str(archive), selected["root"]], timeout=60)
    return json.loads(value)["target"]


def compiler_image():
    value = run(["docker","image","inspect","--format","{{json .}}",IMAGE],timeout=30)
    image = json.loads(value)
    return {"id": image["Id"], "repo_digests": image.get("RepoDigests") or []}


def benchmark(index, paper, base, emcee=None, override=None, image=None):
    folder = base / ("%02d" % index)
    folder.mkdir(parents=True, exist_ok=False)
    result = {"index":index,"cohort":paper["cohort"],"title":paper["short_title"],
              "source":paper["pinned_source_url"],"status":"not-run","image":image,
              "baseline":"not-run","roundtrip":"not-run","edited_build":"not-run"}
    archive=folder/"source.zip"
    stage="acquisition"
    try:
        if index == 1:
            if emcee is None:
                raise ValueError("Pinned emcee checkout required.")
            commit=run(["git","-C",str(emcee),"rev-parse","HEAD"]).strip()
            if commit!="3036b79448cc671d1a1a6c9104b6f0b7c4362850":
                raise ValueError("Unexpected emcee revision.")
            with archive.open("xb") as output:
                subprocess.run(["git","-C",str(emcee),"archive","--format=zip","HEAD",
                                "document/ms.tex","document/aastex.cls"],stdout=output,check=True,timeout=30)
            result["source_revision"]=commit
        else:
            raw=folder/"source.download"
            fetch_source(paper["pinned_source_url"],raw)
            result["download_sha256"]=sha(raw)
            stage="pack"
            pack(raw,archive)
        result["zip_sha256"]=sha(archive)
        stage="inventory"
        report=json.loads(run(["node","corpus/check.cjs",str(archive)],timeout=90))
        result["roots"]=[x["root"] for x in report["roots"]]
        result["root_candidates"]=[{"root":x["root"],"coverage":x["coverage"],"counts":x["counts"],
                                    "root_evidence":x.get("rootEvidence",{})} for x in report["roots"]]
        selected=root_for(report,override,paper["short_title"])
        if not selected:
            result["status"]="root-unresolved"
            return result
        root=selected["root"]
        result.update(root=root,coverage=selected["coverage"],static_counts=selected["counts"],
                      macro_candidates=selected.get("macroCandidates",[]),
                      root_selection="reviewed-override" if override else "unique-candidate" if len(report["roots"])==1 else "literal-title-match")
        engine=paper.get("engine") or "pdflatex"
        result["engine"]=engine
        stage="baseline-build"
        baseline=folder/"baseline.pdf"
        run([sys.executable,"scripts/check_build.py","--root",root,"--engine",engine,"--pdf",str(baseline),str(archive)])
        result.update(baseline="pass",baseline_pdf_sha256=sha(baseline))
        stage="target-selection"
        target=choose_target(archive,selected)
        if not target:
            result["status"]="no-editable-paragraph"
            return result
        result["edit_target"]=target
        stage="editor-roundtrip"
        edited=folder/"edited.zip"
        run(["node","corpus/roundtrip.cjs",str(archive),root,str(edited),target],timeout=90)
        result.update(roundtrip="pass",edited_zip_sha256=sha(edited))
        stage="edited-build"
        pdf=folder/"edited.pdf"
        run([sys.executable,"scripts/check_build.py","--root",root,"--engine",engine,"--pdf",str(pdf),str(edited)])
        result.update(edited_build="pass",edited_pdf_sha256=sha(pdf))
        stage="pdf-marker"
        if not marker_present(run(["pdftotext",str(pdf),"-"],timeout=30)):
            result["status"]="pdf-marker-missing"
            return result
        stage="image-check"
        if compiler_image()!=image:
            result["status"]="compiler-image-changed"
            return result
        result.update(status="pass",pdf_marker_verified=True,compiler_image_verified=True)
        return result
    except (OSError,ValueError,RuntimeError,subprocess.SubprocessError,EOFError,tarfile.TarError,zipfile.BadZipFile) as error:
        # Report stage and exception class, not manuscript text or build logs.
        result.update(status=stage+"-failed",error_type=type(error).__name__)
        if stage=="baseline-build":result["baseline"]="fail"
        if stage=="editor-roundtrip":result["roundtrip"]="fail"
        if stage=="edited-build":result["edited_build"]="fail"
        if stage in ("baseline-build","edited-build"):
            result["build_diagnostic"] = (error.diagnostic if isinstance(error,CommandFailure)
                else "resource-or-time-limit" if isinstance(error,subprocess.TimeoutExpired) else "unclassified")
        return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--shard",type=int,choices=range(4),required=True)
    parser.add_argument("--work",type=Path,required=True)
    parser.add_argument("--report",type=Path,required=True)
    parser.add_argument("--emcee",type=Path)
    parser.add_argument("--roots",type=Path,help="Optional reviewed JSON mapping of index to exact root")
    args=parser.parse_args()
    papers=list(csv.DictReader(MANIFEST.open(encoding="utf-8")))
    if len(papers)!=20:
        raise SystemExit("The release corpus must contain exactly twenty papers.")
    overrides=json.loads(args.roots.read_text()) if args.roots else {}
    args.work=args.work.resolve()
    args.work.mkdir(parents=True,exist_ok=True)
    image=compiler_image()
    results=[]
    for index,paper in enumerate(papers,1):
        if (index-1)//5!=args.shard:continue
        value=benchmark(index,paper,args.work,args.emcee.resolve() if args.emcee else None,
                        overrides.get(str(index)),image)
        results.append(value)
        print(json.dumps(value,ensure_ascii=True),flush=True)
        if index!=1:time.sleep(3)
    args.report.parent.mkdir(parents=True,exist_ok=True)
    args.report.write_text(json.dumps(results,indent=2,ensure_ascii=True)+"\n")
    # Individual failures are diagnostic; the aggregate job evaluates the gate.

if __name__=="__main__":
    main()
