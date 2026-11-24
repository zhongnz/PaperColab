"""Explicit local Docker runner. Never invoked by the web service."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from threading import Thread, Event
import time
import uuid

from compute.contract import validate_bundle, validate_receipt, MAX_LOG


def command(name, directory, spec):
    if "," in str(directory):
        raise ValueError("Input path cannot contain commas.")
    program = ["python3", "-I", "/inputs/main.py"] if spec["language"] == "python" else ["Rscript", "--vanilla", "/inputs/main.R"]
    return ["docker","run","--rm","--name",name,"--pull=never","--network=none",
            "--read-only","--cap-drop=ALL","--security-opt=no-new-privileges",
            "--user=65534:65534","--cpus=1","--memory=512m","--memory-swap=512m",
            "--pids-limit=64","--log-driver=none","--init",
            "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777",
            "--workdir=/tmp","--env=HOME=/tmp","--env=PYTHONDONTWRITEBYTECODE=1",
            "--mount",f"type=bind,source={directory},target=/inputs,readonly",
            "--entrypoint",program[0],spec["image"],*program[1:]]


def execute(bundle, timeout=60):
    spec=validate_bundle(bundle)
    if not 1 <= timeout <= 120:
        raise ValueError("Choose a timeout between 1 and 120 seconds.")
    if not shutil.which("docker"):
        raise ValueError("Docker is required; no host execution fallback.")
    # Exact local image ID, no network pull. User must trust the local image
    # and Docker daemon; container isolation is not a security boundary for
    # hostile code on a shared production host.
    image=subprocess.run(["docker","image","inspect","--format","{{.Id}}",spec["image"]],
                         capture_output=True,text=True,timeout=15,check=False)
    if image.returncode or image.stdout.strip()!=spec["image"]:
        raise ValueError("Pinned image is not installed locally.")
    name="papercolab-run-"+uuid.uuid4().hex
    with tempfile.TemporaryDirectory(prefix="papercolab-input-") as tmp:
        directory=Path(tmp).resolve()
        directory.chmod(0o755)
        main=directory/("main.py" if spec["language"]=="python" else "main.R")
        main.write_bytes(spec["code"]["body"].encode("utf-8"))
        for i,item in enumerate(spec["datasets"],1):
            (directory/f"data-{i}.txt").write_bytes(item["body"].encode("utf-8"))
        for file in directory.iterdir():file.chmod(0o444)
        start=time.monotonic()
        process=subprocess.Popen(command(name,directory,spec),stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
        limit=Event(); log=bytearray()
        def drain():
            while True:
                chunk=process.stdout.read1(8192)
                if not chunk:break
                remaining=MAX_LOG-len(log)
                log.extend(chunk[:remaining])
                if len(chunk)>remaining:
                    limit.set()
                    break
        reader=Thread(target=drain,daemon=True);reader.start()
        status=None
        try:
            while process.poll() is None:
                if limit.is_set():status="output-limit";break
                if time.monotonic()-start>timeout:status="timeout";break
                time.sleep(0.05)
        finally:
            if process.poll() is None or status:
                try:
                    subprocess.run(["docker","rm","--force",name],capture_output=True,timeout=15,check=False)
                finally:
                    if process.poll() is None:process.kill()
            process.wait(timeout=10)
            reader.join(timeout=5)
            process.stdout.close()
        if limit.is_set():status="output-limit"
        code=process.returncode
        if status:code=124 if status=="timeout" else 125
        else:status="succeeded" if code==0 else "failed"
        # Decode and trim safely to the contract's UTF-8 byte limit; log is
        # a bounded textual transcript, not a byte-exact artifact.
        text=bytes(log).decode("utf-8","replace")
        text="".join(c for c in text if c in "\n\t" or c.isprintable())
        text=text.encode("utf-8")[:MAX_LOG].decode("utf-8","ignore")
        receipt={"format":"papercolab-receipt-v1","experiment_id":spec["id"],
                 "bundle_sha256":bundle["sha256"],"image":spec["image"],"runner":"docker-local-v1",
                 "status":status,"exit_code":code,"elapsed_ms":int((time.monotonic()-start)*1000),
                 "log":text,"log_sha256":hashlib.sha256(text.encode("utf-8")).hexdigest()}
        return validate_receipt(receipt,bundle)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle",type=Path)
    parser.add_argument("--receipt",required=True,type=Path)
    parser.add_argument("--timeout",type=int,default=60)
    args=parser.parse_args()
    try:
        if args.receipt.exists() or args.bundle.stat().st_size>4*1024*1024:
            raise ValueError("Choose a new receipt file and a bounded bundle.")
        bundle=json.loads(args.bundle.read_text(encoding="utf-8"))
        receipt=execute(bundle,args.timeout)
        fd=os.open(args.receipt,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,"w",encoding="utf-8") as out:json.dump(receipt,out,ensure_ascii=True,indent=2)
        print("Receipt saved locally; outcome:",receipt["status"],". Review before uploading.")
        return 0 if receipt["status"]=="succeeded" else 1
    except (OSError,ValueError,subprocess.SubprocessError) as error:
        print("Experiment could not finish:",error)
        return 1

if __name__=="__main__":
    raise SystemExit(main())
