"""Collect repeatable Gate 1 source, editor and isolated PDF evidence."""

import argparse
import csv
from datetime import datetime, timezone
import hashlib
from http.client import HTTPException
import io
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
import zipfile

from pack import MIB, pack


CORPUS = Path(__file__).resolve().parent
REPO = CORPUS.parent
TEX_TAG = "texlive/texlive:TL2025-historic"
TEX_PIN = "texlive/texlive@sha256:dbd65d778eb83de9b45fb0a8deb3afe44cbbaba2272e4e644e94dda52c7109"
ARXIV = re.compile(r"https://arxiv\.org/src/(\d{4}\.\d{4,5}v\d+)")
EMCEE = re.compile(r"https://github\.com/dfm/emcee/tree/([0-9a-f]{40})/document")
EMCEE_FILES = {
    "document/ms.tex": "bcfbba68c3867f2a8eaec96650414a09cb528fdb",
    "document/aastex.cls": "a8ad35a7a3f16f986a24c349d0e0fbdfa3485794",
}
USER_AGENT = "PaperColab corpus (https://github.com/zhongnz/PaperColab)"


class PinnedRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, new_url):
        old, new = urlsplit(request.full_url), urlsplit(new_url)
        arxiv_hosts = {"arxiv.org", "export.arxiv.org"}
        version = old.path.rsplit("/", 1)[-1]
        arxiv_path = old.netloc in arxiv_hosts and new.netloc in arxiv_hosts and new.path in {
            f"/src/{version}", f"/e-print/{version}",
        }
        same_path = old.netloc == new.netloc == "raw.githubusercontent.com" and old.path == new.path
        if new.scheme != "https" or new.query or new.fragment or not (arxiv_path or same_path):
            raise ValueError("The source redirected away from its pinned version.")
        return super().redirect_request(request, fp, code, msg, headers, new_url)


OPENER = build_opener(PinnedRedirects())


def digest(path):
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def run(command, timeout=45):
    result = subprocess.run(command, cwd=REPO, capture_output=True, text=True, encoding="utf-8",
                            errors="replace", timeout=timeout, check=False)
    if result.returncode:
        diagnostic = result.stderr.strip() or result.stdout.strip()
        raise ValueError(diagnostic[-4000:] or f"{command[0]} exited with status {result.returncode}.")
    return result.stdout


def fetch(url, path, offline, validate):
    if path.is_file():
        if not 0 < path.stat().st_size <= 64 * MIB:
            raise ValueError("Cached source exceeds the source limit or is empty.")
        validate(path.read_bytes())
        return "cache"
    if offline:
        raise ValueError("Pinned source is missing from the local cache.")
    request = Request(url, headers={"User-Agent": USER_AGENT})
    with OPENER.open(request, timeout=30) as response:
        header = response.headers.get("Content-Length", "")
        declared = int(header) if header.isascii() and header.isdecimal() else None
        if declared is not None and declared > 64 * MIB:
            raise ValueError("Source download exceeds 64 MiB.")
        data = response.read(64 * MIB + 1)
    if not 0 < len(data) <= 64 * MIB:
        raise ValueError("Source download exceeds 64 MiB or is empty.")
    if declared is not None and declared != len(data):
        raise ValueError("Source download does not match the declared length.")
    validate(data)
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as file:
        temp = Path(file.name)
        try:
            file.write(data)
            file.close()
            temp.replace(path)
        finally:
            temp.unlink(missing_ok=True)
    return "download"


def validate_arxiv(data):
    if not data.startswith(b"\x1f\x8b") and b"\\documentclass" not in data and b"\\begin{document}" not in data:
        # An uncompressed source tar may put graphics before the first TeX file.
        # The packer validates the full archive before producing the ZIP.
        if not tarfile.is_tarfile(io.BytesIO(data)):
            raise ValueError("The pinned URL returned neither TeX source nor a source archive.")


def check_git_blob(data, expected):
    header = f"blob {len(data)}\0".encode("ascii")
    if hashlib.sha1(header + data, usedforsecurity=False).hexdigest() != expected:
        raise ValueError("Downloaded bytes do not match the pinned Git blob.")


def pack_source(row, cached, archive, offline):
    url = row["pinned_source_url"]
    if ARXIV.fullmatch(url):
        source = cached / "download"
        origin = fetch(url, source, offline, validate_arxiv)
        pack(source, archive)
        return {"origin": origin, "downloadSha256": digest(source)}

    revision = EMCEE.fullmatch(url)[1]
    files = []
    with zipfile.ZipFile(archive, "x", compression=zipfile.ZIP_DEFLATED) as output:
        for name, expected in EMCEE_FILES.items():
            source = cached / name
            pinned = f"https://raw.githubusercontent.com/dfm/emcee/{revision}/{name}"
            origin = fetch(pinned, source, offline, lambda data: check_git_blob(data, expected))
            entry = zipfile.ZipInfo(name)
            entry.compress_type = zipfile.ZIP_DEFLATED
            output.writestr(entry, source.read_bytes())
            files.append({"path": name, "origin": origin, "sha256": digest(source)})
    return {"files": files}


def choose_root(report, configured):
    roots = {root["root"]: root for root in report["roots"]}
    if configured:
        if configured not in roots:
            raise ValueError(f"Configured root {configured!r} was not detected.")
        return roots[configured]
    if len(roots) == 1:
        return next(iter(roots.values()))
    if not roots:
        raise ValueError("No LaTeX manuscript root was found.")
    raise ValueError("Multiple possible roots. Identify the publication root in papers.csv.")


def build_tools(no_build):
    if no_build:
        return {"status": "skipped", "diagnostic": "Builds disabled for this run."}
    if not shutil.which("docker"):
        return {"status": "unavailable", "diagnostic": "Docker is unavailable."}
    try:
        refs = json.loads(run(["docker", "image", "inspect", "--format", "{{json .RepoDigests}}", TEX_TAG])) or []
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        return {"status": "unavailable", "diagnostic": str(error)}
    if TEX_PIN not in refs:
        return {"status": "unavailable", "diagnostic": f"Tag {TEX_TAG} with the image pulled as {TEX_PIN}."}
    return {"status": "ready"}


def build(archive, root, engine, pdf):
    try:
        run([sys.executable, REPO / "scripts/check_build.py", "--root", root, "--engine", engine,
             "--pdf", pdf, archive], timeout=145)
        return {"status": "passed", "sha256": digest(pdf), "bytes": pdf.stat().st_size}
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        return {"status": "failed", "diagnostic": str(error)}


def pdf_evidence(pdf, marker):
    text = run(["pdftotext", "-enc", "UTF-8", pdf, "-"])
    normalized = " ".join(text.split()).replace("round- trip", "round-trip")
    evidence = {"textSha256": hashlib.sha256(normalized.encode()).hexdigest(), "pages": text.count("\f"),
                "markerFound": marker in normalized}
    return evidence, normalized


def compare_pdfs(original, edited, marker):
    if not shutil.which("pdftotext"):
        return {"status": "unavailable", "diagnostic": "pdftotext is unavailable."}
    try:
        baseline, before = pdf_evidence(original, marker)
        result, after = pdf_evidence(edited, marker)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        return {"status": "failed", "diagnostic": str(error)}
    passed = not baseline["markerFound"] and result["markerFound"]
    equivalent_text = before == " ".join(after.replace(marker, "", 1).split())
    return {"status": "passed" if passed else "failed", "original": baseline, "edited": result,
            "sameTextWithoutMarker": equivalent_text}


def check_paper(row, cache, output, offline, tools):
    paper = row["id"]
    folder = output / paper
    folder.mkdir()
    archive, edited = folder / "original.zip", folder / "edited.zip"
    original_pdf, edited_pdf = folder / "original.pdf", folder / "edited.pdf"
    result = {"id": paper, "title": row["short_title"], "cohort": row["cohort"],
              "record": row["record_url"], "pinnedSource": row["pinned_source_url"], "engine": row.get("engine") or "pdflatex",
              "gatePass": False}
    stages = ("source", "inspection", "roundTrip", "originalBuild", "editedBuild", "pdfComparison")
    result.update({stage: {"status": "not-run"} for stage in stages})
    try:
        result["source"] = {"status": "passed", **pack_source(row, cache / paper, archive, offline),
                            "archiveSha256": digest(archive)}
    except (OSError, ValueError, EOFError, HTTPException, tarfile.TarError, zipfile.BadZipFile) as error:
        result["source"] = {"status": "failed", "diagnostic": str(error)}
        return result
    try:
        inspected = json.loads(run(["node", CORPUS / "check.cjs", archive]))
        result["inspection"] = {"status": "passed", "rootCandidates": [root["root"] for root in inspected["roots"]],
                                "archiveFindings": inspected["archiveFindings"]}
        selected = choose_root(inspected, row.get("root"))
        result["inspection"].update(selected)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        result["inspection"].update({"status": "failed", "diagnostic": str(error)})
        return result
    root, coverage = selected["root"], selected["coverage"]
    if not coverage["editableParagraphs"]:
        result["roundTrip"] = {"status": "no-editable-paragraph"}
    else:
        try:
            evidence = json.loads(run(["node", CORPUS / "roundtrip.cjs", archive, root, edited, "--json"]))
            result["roundTrip"] = {"status": "passed", **evidence}
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            result["roundTrip"] = {"status": "failed", "diagnostic": str(error)}
    if tools["status"] != "ready":
        result["originalBuild"] = dict(tools)
        if result["roundTrip"]["status"] == "passed":
            result["editedBuild"] = dict(tools)
        return result

    result["originalBuild"] = build(archive, root, result["engine"], original_pdf)
    if result["roundTrip"]["status"] == "passed":
        result["editedBuild"] = build(edited, root, result["engine"], edited_pdf)
    if result["originalBuild"]["status"] == result["editedBuild"]["status"] == "passed":
        result["pdfComparison"] = compare_pdfs(original_pdf, edited_pdf, result["roundTrip"]["marker"])
    result["gatePass"] = result["pdfComparison"]["status"] == "passed" and not coverage["uninspectedSources"]
    return result


def papers():
    with (CORPUS / "papers.csv").open(newline="", encoding="utf-8") as file:
        rows = list(csv.DictReader(file))
    seen = set()
    for row in rows:
        url = row["pinned_source_url"]
        if match := ARXIV.fullmatch(url):
            paper = match[1]
        elif EMCEE.fullmatch(url):
            paper = "emcee"
        else:
            raise ValueError(f"Unsupported source pin for {row['short_title']}.")
        if paper in seen:
            raise ValueError(f"Duplicate entry for {paper}.")
        seen.add(paper)
        row["id"] = paper
    return rows


def save_report(path, report):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--paper", action="append", help="Limit to an arXiv version ID or emcee. Repeat to select several.")
    parser.add_argument("--work-dir", type=Path, default=CORPUS / "local/gate1")
    parser.add_argument("--report", type=Path, help="Write the JSON report at this path.")
    parser.add_argument("--offline", action="store_true", help="Use cached sources without downloading them.")
    parser.add_argument("--no-build", action="store_true", help="Measure source and editor results without Docker.")
    parser.add_argument("--require-passes", type=int, default=0, help="Fail after reporting if fewer papers pass the full check.")
    args = parser.parse_args()
    try:
        rows = papers()
    except (OSError, ValueError) as error:
        parser.error(str(error))
    if args.paper:
        unknown = set(args.paper) - {row["id"] for row in rows}
        if unknown:
            parser.error("Unknown corpus ID: " + ", ".join(sorted(unknown)))
        rows = [row for row in rows if row["id"] in args.paper]
    if not 0 <= args.require_passes <= len(rows):
        parser.error("Required passes must be between zero and the number of selected papers.")

    cache = args.work_dir.resolve() / "sources"
    runs = args.work_dir.resolve() / "runs"
    runs.mkdir(parents=True, exist_ok=True)
    output = Path(tempfile.mkdtemp(prefix="check-", dir=runs))
    report_path = args.report.resolve() if args.report else output / "report.json"
    tools = build_tools(args.no_build)
    report = {"startedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"), "texImage": TEX_PIN,
              "buildTools": tools, "selected": len(rows), "requiredPasses": args.require_passes, "papers": []}
    save_report(report_path, report)
    for row in rows:
        if not args.offline and ARXIV.fullmatch(row["pinned_source_url"]) and not (cache / row["id"] / "download").is_file():
            time.sleep(3)
        result = check_paper(row, cache, output, args.offline, tools)
        report["papers"].append(result)
        save_report(report_path, report)
        print(f"{row['id']}: source {result['source']['status']}, inspection {result['inspection']['status']}, "
              f"round trip {result['roundTrip']['status']}, original PDF {result['originalBuild']['status']}, "
              f"edited PDF {result['editedBuild']['status']}", flush=True)
    report["inspected"] = sum(paper["inspection"]["status"] == "passed" for paper in report["papers"])
    report["byteRoundTrips"] = sum(paper["roundTrip"]["status"] == "passed" for paper in report["papers"])
    report["gatePasses"] = sum(paper["gatePass"] for paper in report["papers"])
    save_report(report_path, report)
    print(f"{report['inspected']}/{len(rows)} inspected, {report['byteRoundTrips']}/{len(rows)} byte round trips, "
          f"{report['gatePasses']}/{len(rows)} full checks passed. Report: {report_path}")
    return int(report["gatePasses"] < args.require_passes)


if __name__ == "__main__":
    raise SystemExit(main())
