"""Aggregate reports, reject missing/duplicate corpus rows, enforce an honest release gate."""
import argparse
import csv
import json
from pathlib import Path

MANIFEST=Path(__file__).with_name("papers.csv")


def summarize(rows, papers):
    ids=[row["index"] for row in rows]
    if len(papers)!=20 or sorted(ids)!=list(range(1,21)):
        raise ValueError("Need exactly one result for every corpus paper.")
    for row in rows:
        paper=papers[row["index"]-1]
        if row["source"]!=paper["pinned_source_url"] or row["title"]!=paper["short_title"]:
            raise ValueError("Report does not match pinned corpus.")
        if row["status"]=="pass" and (any(row.get(k)!="pass" for k in ("baseline","roundtrip","edited_build"))
               or not row.get("coverage") or not row.get("edited_pdf_sha256") or not row.get("zip_sha256")):
            raise ValueError("Incomplete claimed pass.")
    counts={}
    for row in rows:
        counts[row["status"]]=counts.get(row["status"],0)+1
    inspected=[r["coverage"] for r in rows if r.get("coverage")]
    editable=sum(c["editableParagraphs"] for c in inspected)
    fallback=sum(c["fallbackParagraphs"] for c in inspected)
    return {"papers":20,"passed":counts.get("pass",0),"gate_met":counts.get("pass",0)>=18,
            "status_counts":counts,"coverage_papers":len(inspected),
            "editable_paragraphs":editable,"fallback_paragraphs":fallback,
            "paragraph_coverage":editable/(editable+fallback) if editable+fallback else None}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reports",nargs="+",type=Path)
    parser.add_argument("--require-gate",action="store_true")
    args=parser.parse_args()
    rows=[row for path in args.reports for row in json.loads(path.read_text())]
    with MANIFEST.open(encoding="utf-8") as file:papers=list(csv.DictReader(file))
    summary=summarize(rows,papers)
    print(json.dumps(summary,indent=2))
    print("\n| Paper | Result | Editable paragraphs | Fallback paragraphs |")
    print("|---|---|---:|---:|")
    for row in sorted(rows,key=lambda x:x["index"]):
        c=row.get("coverage",{})
        print(f"| {row['title']} | {row['status']} | {c.get('editableParagraphs','—')} | {c.get('fallbackParagraphs','—')} |")
    if args.require_gate and not summary["gate_met"]:
        raise SystemExit("Release fidelity gate not met: fewer than 18 of 20 passed.")

if __name__=="__main__":
    main()
