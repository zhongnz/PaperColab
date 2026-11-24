"""Explicit model-independent task workflow; draft and submit are separate."""
import argparse
import json
import sys
from pathlib import Path
from agents.client import ClientError, TaskClient
from agents.providers import ModelProvider


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    sub=parser.add_subparsers(dest="command",required=True)
    sub.add_parser("context",help="Print assigned context (contains research data).")
    draft=sub.add_parser("draft",help="Generate a local proposal file; does not submit.")
    draft.add_argument("--provider",choices=["openai","anthropic","local"],required=True)
    draft.add_argument("--model",required=True)
    draft.add_argument("--allow-remote",action="store_true",
                       help="Explicitly allow sending assigned research context to the named remote provider.")
    draft.add_argument("--output",type=Path,required=True)
    submit=sub.add_parser("submit",help="Submit a reviewed local proposal file to the human review queue.")
    submit.add_argument("file",type=Path)
    args=parser.parse_args()
    try:
        client=TaskClient.from_env()
        if args.command=="context":
            print(json.dumps(client.context(),ensure_ascii=False,indent=2))
        elif args.command=="draft":
            if args.output.exists():
                raise ClientError("Output already exists; choose a new file.")
            context=client.context()
            proposal=ModelProvider(args.provider,args.model,args.allow_remote).generate(context)
            # Exclusive create; no overwrite and no secret or context dump.
            import os
            fd=os.open(args.output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
            with os.fdopen(fd,"w",encoding="utf-8") as out:
                json.dump(proposal,out,ensure_ascii=False,indent=2)
                out.write("\n")
            print("Proposal written locally. Inspect it before submitting.")
        else:
            if args.file.stat().st_size>512*1024:
                raise ClientError("Proposal file exceeds size limit.")
            proposal=json.loads(args.file.read_text(encoding="utf-8"))
            result=client.submit(proposal)
            print(json.dumps({"task_id":result["task_id"],"suggestion_id":result["suggestion"]["id"],"status":"pending"}))
    except (ClientError,OSError,ValueError) as error:
        # Avoid printing paths, provider bodies or raw JSON errors.
        print(str(error) if isinstance(error,ClientError) else "Could not read or write proposal file.",file=sys.stderr)
        return 1
    return 0


if __name__=="__main__":
    raise SystemExit(main())
