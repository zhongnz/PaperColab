"""Opt-in loopback compilation endpoint; no persistent job queue or host TeX."""
import base64
import hashlib
import io
import json
import re
import shutil
import struct
import subprocess
import tempfile
from threading import BoundedSemaphore
import uuid
import zipfile
from pathlib import PurePosixPath

from scripts.check_build import command, clean_log, MIB
from scripts.build_worker import valid_path, ENGINES
from scripts.build_diagnostics import explain
from server.service import ServiceError

MAX_BUNDLE=24*MIB


def decode_bundle(raw):
    if not 0<len(raw)<=MAX_BUNDLE:
        raise ValueError("Invalid preview bundle size.")
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        entries=z.infolist()
        names=[e.filename for e in entries]
        expected=["document.pdf"]+["page-"+str(i)+".png" for i in range(1,len(names))]
        if names!=expected or not 1<=len(names)<=4:
            raise ValueError("Invalid preview members.")
        pdf=None;pages=[]
        for e in entries:
            limit=16*MIB if e.filename=="document.pdf" else 2*MIB
            if e.compress_type!=zipfile.ZIP_STORED or not 0<e.file_size<=limit or e.flag_bits&1:
                raise ValueError("Invalid preview entry.")
            with z.open(e) as stream:
                data=stream.read(limit+1)
                if len(data)!=e.file_size or stream.read(1):raise ValueError("Invalid preview entry size.")
            if e.filename=="document.pdf":
                if not data.startswith(b"%PDF-"):raise ValueError("Invalid PDF header.")
                pdf=data
            else:
                if len(data)<33 or data[:16]!=b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR":
                    raise ValueError("Invalid raster header.")
                width,height=struct.unpack(">II",data[16:24])
                if not 1<=width<=1200 or not 1<=height<=1200:
                    raise ValueError("Raster dimensions exceed preview bounds.")
                pages.append(data)
    return {"pdf_b64":base64.b64encode(pdf).decode("ascii"),
            "pdf_sha256":hashlib.sha256(pdf).hexdigest(),
            "pages":[base64.b64encode(p).decode("ascii") for p in pages]}


def compile_bundle(archive,root,engine):
    if not shutil.which("docker"):
        raise ValueError("Docker is required; install it and pre-pull the configured TeX Live image.")
    name="papercolab-preview-"+uuid.uuid4().hex
    # Reuse the existing bounded isolated verifier. Capture only a
    # bounded output bundle; worker uses tmpfs and fixed output limits.
    with tempfile.TemporaryFile() as result:
        try:
            proc=subprocess.run(command(name,root,engine,preview=True),input=archive,stdout=result,
                                stderr=subprocess.PIPE,timeout=120,check=False)
        except (subprocess.TimeoutExpired,KeyboardInterrupt):
            subprocess.run(["docker","rm","--force",name],capture_output=True,timeout=15,check=False)
            raise ValueError("Build exceeded the 120-second limit or was interrupted.") from None
        if proc.returncode:
            raise ValueError(clean_log(proc.stderr[-8000:]).strip() or "Isolated build failed.")
        if result.tell()>MAX_BUNDLE:
            raise ValueError("Preview bundle exceeds its size limit.")
        result.seek(0)
        return decode_bundle(result.read(MAX_BUNDLE+1))


class Preview:
    def __init__(self, service, enabled=False):
        self.service=service
        self.enabled=enabled
        self.slot=BoundedSemaphore(1)

    def _actor(self, token, project):
        actor=self.service.actor_by_token(token)
        self.service.require(actor,project,"read")
        if actor["kind"]!="human":
            raise ServiceError(403,"Only a human project member may request a local build.")
        return actor

    def handle(self, project, headers, body):
        if not self.enabled:
            return 404,{"error":"Local PDF preview is disabled."}
        auth=headers.get("authorization","")
        token=auth[7:].strip() if auth.lower().startswith("bearer ") else ""
        try:
            data=json.loads(body)
            if not isinstance(data,dict) or set(data)!={"root","engine","revision"}:
                raise ValueError()
            root,engine,revision=data["root"],data["engine"],data["revision"]
            if (not isinstance(root,str) or not valid_path(root) or
                not re.fullmatch(r"[\w][\w .-]*\.(?:tex|ltx)",PurePosixPath(root).name,re.I) or
                not isinstance(engine,str) or engine not in ENGINES or type(revision) is not int):
                raise ValueError()
        except (ValueError,TypeError,UnicodeError):
            return 400,{"error":"Provide a supported manuscript root, engine and current revision."}
        acquired=False
        try:
            with self.service.lock:
                actor=self._actor(token,project)
                if self.service.manuscript_revision(actor,project)["revision"]!=revision:
                    raise ServiceError(409,"Manuscript changed. Refresh before compiling.")
                row=self.service.db.execute("SELECT is_root,is_text FROM files WHERE project_id=? AND path=?",(project,root)).fetchone()
                if not row or not row["is_root"] or not row["is_text"]:
                    raise ServiceError(400,"Choose a detected manuscript root in this project.")
                acquired=self.slot.acquire(blocking=False)
                if not acquired:
                    raise ServiceError(429,"A local compilation is already running.")
                archive=self.service.export_zip(actor,project)
                if not 0<len(archive)<=64*MIB:
                    raise ServiceError(400,"Manuscript ZIP exceeds 64 MiB.")
                source_hash=hashlib.sha256(archive).hexdigest()
            # Crucially, never wait for the container with the SQLite
            # lock held. Other projects and edits continue normally.
            try:
                result=compile_bundle(archive,root,engine)
                status={"status":"succeeded",**result}
            except ValueError as error:
                status={"status":"failed","diagnostic":str(error)[:8000],**explain(str(error))}
            except (OSError,subprocess.SubprocessError,zipfile.BadZipFile):
                status={"status":"failed","diagnostic":"The isolated build worker could not return a valid result.",**explain("")}
            with self.service.lock:
                current_actor=self._actor(token,project)
                current=self.service.manuscript_revision(current_actor,project)["revision"]
                if current_actor["id"]!=actor["id"]:
                    raise ServiceError(403,"Build access changed.")
            return 200,{**status,"revision":revision,"current_revision":current,
                        "root":root,"engine":engine,"source_sha256":source_hash}
        except ServiceError as error:
            return error.status,{"error":str(error)}
        except Exception:
            return 500,{"error":"The local compilation request failed. Contact the operator."}
        finally:
            if acquired:self.slot.release()
