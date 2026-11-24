"""Local-only pilot evidence: inspect snapshots, compare exported members and optionally build PDFs.

This tool does not upload, modify the input ZIPs, approve edited prose, or
establish outside-cell byte fidelity for an arbitrary human editing session.
Reports contain local filenames and hashes; keep them private.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import zipfile

from scripts.build_worker import unpack, valid_path, MIB, ENGINES
from scripts.check_build import IMAGE, build_metadata
from scripts.build_diagnostics import build_diagnostic

ROOT=Path(__file__).resolve().parents[1]


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream,"sha256").hexdigest()


def snapshot(path, directory):
    """Use the same bounded archive verifier as the isolated compiler."""
    with path.open("rb") as stream:
        data=stream.read(64*MIB+1)
    if not 0<len(data)<=64*MIB:
        raise ValueError("Choose a ZIP between 1 byte and 64 MiB.")
    directory.mkdir()
    archive=directory/"snapshot.zip"
    archive.write_bytes(data)
    content=directory/"members"
    content.mkdir()
    unpack(data,content)
    members={p.relative_to(content).as_posix():digest(p) for p in content.rglob("*") if p.is_file()}
    if not members:
        raise ValueError("Archive has no regular files.")
    return archive,members


def compare_members(before,after,allowed):
    allowed=set(allowed)
    if not allowed or any(not valid_path(p) or Path(p).suffix.lower() not in {".tex",".ltx"} or p not in before for p in allowed):
        raise ValueError("Explicitly approve existing .tex/.ltx file paths only.")
    removed=sorted(before.keys()-after.keys())
    added=sorted(after.keys()-before.keys())
    changed=sorted(p for p in before.keys()&after.keys() if before[p]!=after[p])
    unexpected=sorted(set(changed)-allowed)
    return {"status":"pass" if changed and not (removed or added or unexpected) else "fail",
            "changed_files":changed,"added_files":added,"removed_files":removed,
            "unexpected_changes":unexpected,"unchanged_files":len(before.keys()&after.keys())-len(changed),
            "approved_files":sorted(allowed),
            "scope":"Member byte hashes only; inspect changes within approved files separately."}


def run(args, timeout=180):
    return subprocess.run(args,cwd=ROOT,capture_output=True,text=True,encoding="utf-8",errors="replace",timeout=timeout)


def inspect(archive, root):
    result=run(["node","corpus/check.cjs",str(archive)],timeout=90)
    if result.returncode:
        raise ValueError("Static inspection failed. Inspect this ZIP locally in PaperColab.")
    report=json.loads(result.stdout)
    candidates=[r for r in report["roots"] if r["root"]==root]
    if len(candidates)!=1:
        raise ValueError("The selected root is not an unambiguous detected candidate path.")
    row=candidates[0]
    c=row["coverage"]
    return {"detected_root_count":len(report["roots"]),"root":root,"counts":row["counts"],
            "coverage":{k:c[k] for k in ("editableParagraphs","fallbackParagraphs","editableHeadings","fallbackHeadings")},
            "full_file_fallbacks":len(c.get("fullFileFallbacks",[])),
            "uninspected_sources":len(c.get("uninspectedSources",[])),
            "coverage_note":"Classified ranges only; full-file fallbacks may not count as paragraphs."}


def image_identity():
    value=run(["docker","image","inspect","--format","{{.Id}}",IMAGE],timeout=30)
    identity=value.stdout.strip()
    if value.returncode or not re.fullmatch(r"sha256:[a-f0-9]{64}",identity):
        raise ValueError("Docker or the locally installed TeX Live image is unavailable.")
    return identity


def build(archive,root,engine,output):
    identity=image_identity()
    result=run([sys.executable,"scripts/check_build.py","--root",root,"--engine",engine,"--pdf",str(output),str(archive)])
    if result.returncode:
        return {"status":"fail","diagnostic":build_diagnostic(result.stderr[-32000:])}
    profile=build_metadata(result.stdout.encode())
    if not profile or not output.is_file() or identity!=image_identity():
        return {"status":"fail","diagnostic":"unverified-build-identity"}
    return {"status":"pass","image":identity,"engine":engine,"profile":profile,"pdf_sha256":digest(output)}


def check(original,root,engine,edited=None,allowed=(),compile_pdf=False):
    if not valid_path(root) or Path(root).suffix.lower() not in {".tex",".ltx"} or engine not in ENGINES:
        raise ValueError("Choose a conventional TeX root and supported engine.")
    with tempfile.TemporaryDirectory(prefix="papercolab-pilot-") as temp:
        work=Path(temp)
        before,members=snapshot(original,work/"original")
        inventory=inspect(before,root)
        report={"format":"papercolab-local-pilot-v1","original_sha256":digest(before),"original_files":len(members),
                "inventory":inventory,"baseline":{"status":"not-run"}}
        if compile_pdf:
            report["baseline"]=build(before,root,engine,work/"original.pdf")
        eligible=report["baseline"]["status"]=="pass" and inventory["coverage"]["editableParagraphs"]>0
        report["baseline_eligible"]=eligible
        report["status"]="baseline-ready" if eligible else "baseline-not-ready" if compile_pdf else "inspection-only"
        if edited is not None:
            after,new_members=snapshot(edited,work/"edited")
            comparison=compare_members(members,new_members,allowed)
            report.update(edited_sha256=digest(after),comparison=comparison,edited_build={"status":"not-run"})
            # Do not run a second build on an unexpected export or failed
            # baseline. Both compilation steps use temporary snapshots.
            if compile_pdf and eligible and comparison["status"]=="pass":
                report["edited_build"]=build(after,root,engine,work/"edited.pdf")
            a,b=report["baseline"],report["edited_build"]
            matching=a["status"]==b["status"]=="pass" and all(a.get(k)==b.get(k) for k in ("image","engine","profile"))
            report["matching_build_profile"]=matching
            report["status"]="review-required" if matching and comparison["status"]=="pass" else "comparison-only" if not compile_pdf and comparison["status"]=="pass" else "blocked"
        report["manual_review_required"]=True
        return report


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("original",type=Path)
    parser.add_argument("--root",required=True)
    parser.add_argument("--engine",default="pdflatex",choices=sorted(ENGINES))
    parser.add_argument("--edited",type=Path)
    parser.add_argument("--allow-changed",action="append",default=[])
    parser.add_argument("--build",action="store_true",help="Explicitly run local isolated Docker builds on trusted copies.")
    parser.add_argument("--report",required=True,type=Path,help="New private JSON report; existing files are never overwritten.")
    args=parser.parse_args()
    if args.report.exists():
        parser.error("Report already exists. Choose a new report filename.")
    if bool(args.edited)!=bool(args.allow_changed):
        parser.error("An edited ZIP requires one or more explicitly approved changed file paths.")
    try:
        report=check(args.original,args.root,args.engine,args.edited,args.allow_changed,args.build)
        with args.report.open("x",encoding="utf-8") as dest:
            json.dump(report,dest,indent=2,ensure_ascii=True)
            dest.write("\n")
    except (OSError,ValueError,RuntimeError,subprocess.SubprocessError,zipfile.BadZipFile):
        # Never emit paths, source fragments or raw build logs in a
        # participant's terminal transcript. The UI offers local diagnostics.
        parser.exit(2,"Local pilot check could not complete. Check input ZIPs, selected root, approved paths, runtime and report location.\n")
    print("Pilot check: "+report["status"]+". Private report saved; manual review required.")
    if report["status"] in {"blocked","baseline-not-ready"}:
        raise SystemExit(1)


if __name__=="__main__":
    main()
