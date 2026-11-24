"""Versioned portable experiment contract; hashes establish identity, not truth."""
import hashlib
import json
import math
import re
import uuid

MAX_INPUT = 512 * 1024
MAX_LOG = 128 * 1024
MAX_OUTPUT = 64 * 1024
OUTPUT_PREFIX = 'PAPERCOLAB_OUTPUT_V1 '
IMAGE = re.compile(r"sha256:[a-f0-9]{64}")
DIGEST = re.compile(r"[a-f0-9]{64}")


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=True,
                         separators=(",", ":"), allow_nan=False).encode("ascii")).hexdigest()


def validate_bundle(bundle):
    if not isinstance(bundle, dict) or set(bundle) != {"spec", "sha256"}:
        raise ValueError("Invalid experiment bundle.")
    spec = bundle["spec"]
    if not isinstance(spec, dict) or set(spec) != {"format","id","language","image","code","datasets"}:
        raise ValueError("Invalid experiment specification.")
    if spec["format"] != "papercolab-experiment-v1" or spec["language"] not in ("python","r"):
        raise ValueError("Unsupported experiment format or language.")
    if not isinstance(spec["image"], str) or not IMAGE.fullmatch(spec["image"]):
        raise ValueError("Use an exact local Docker image ID (sha256:...).")
    if str(uuid.UUID(spec["id"])) != spec["id"]:
        raise ValueError("Invalid experiment ID.")
    inputs = spec["datasets"]
    if not isinstance(inputs, list) or len(inputs) > 8:
        raise ValueError("At most eight text datasets.")
    seen = set()
    size = 0
    for item in [spec["code"], *inputs]:
        if not isinstance(item, dict) or set(item) != {"id","revision","body"}:
            raise ValueError("Invalid pinned input.")
        if not isinstance(item["id"], str) or item["id"] in seen or type(item["revision"]) is not int or item["revision"] < 1 or not isinstance(item["body"], str):
            raise ValueError("Invalid pinned input identity or revision.")
        seen.add(item["id"])
        size += len(item["body"].encode("utf-8"))
    if not spec["code"]["body"].strip() or size > MAX_INPUT:
        raise ValueError("Code required; total input limit is 512 KiB.")
    if bundle["sha256"] != digest(spec):
        raise ValueError("Experiment bundle digest does not match.")
    return spec


def _label(value, limit=200):
    if not isinstance(value, str) or not value.strip() or len(value) > limit or not value.isprintable():
        raise ValueError("Output labels must be bounded printable text.")


def validate_outputs(outputs):
    if not isinstance(outputs, list) or len(outputs) > 8:
        raise ValueError("At most eight structured outputs.")
    names = set()
    for item in outputs:
        if not isinstance(item, dict):
            raise ValueError("Invalid output.")
        kind = item.get("kind")
        keys = {"name", "kind", "title"} | ({"columns", "rows"} if kind == "table" else {"x_label","y_label","points"})
        if kind not in ("table","series") or set(item) != keys:
            raise ValueError("Unsupported structured output.")
        name = item["name"]
        if not isinstance(name, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,40}", name) or name in names:
            raise ValueError("Output names must be unique safe identifiers.")
        names.add(name)
        _label(item["title"])
        if kind == "table":
            columns, rows = item["columns"], item["rows"]
            if not isinstance(columns,list) or not 1 <= len(columns) <= 12 or not isinstance(rows,list) or not 1 <= len(rows) <= 200:
                raise ValueError("Table limit: 12 columns and 200 rows.")
            for col in columns:
                _label(col,100)
            if len(set(columns)) != len(columns):
                raise ValueError("Table column names must be distinct.")
            for row in rows:
                if not isinstance(row,list) or len(row)!=len(columns):
                    raise ValueError("Table rows must match columns.")
                for cell in row:
                    if isinstance(cell,str):
                        if len(cell)>200 or (cell and not cell.isprintable()):
                            raise ValueError("Invalid table text.")
                    elif cell is not None and (type(cell) not in (int,float) or not -1e100 <= cell <= 1e100):
                        raise ValueError("Invalid numeric table value.")
        else:
            _label(item["x_label"],100);_label(item["y_label"],100)
            points=item["points"]
            if not isinstance(points,list) or not 2 <= len(points) <= 200:
                raise ValueError("Series require 2 to 200 points.")
            for pair in points:
                if not isinstance(pair,list) or len(pair)!=2 or any(type(x) not in (int,float) or not -1e100 <= x <= 1e100 for x in pair):
                    raise ValueError("Series points must be bounded finite numbers.")
    if len(json.dumps(outputs,ensure_ascii=True,allow_nan=False).encode("ascii"))>MAX_OUTPUT:
        raise ValueError("Structured outputs exceed 64 KiB.")
    return outputs


def extract_outputs(text):
    """Only complete, explicitly marked JSON lines are parsed; never execute."""
    outputs=[]
    for line in text.splitlines():
        if line.startswith(OUTPUT_PREFIX):
            outputs.append(json.loads(line[len(OUTPUT_PREFIX):]))
    return validate_outputs(outputs)


def validate_receipt(receipt, bundle):
    spec = validate_bundle(bundle)
    fields = {"format","experiment_id","bundle_sha256","image","runner","status","exit_code","elapsed_ms","log","log_sha256"}
    if not isinstance(receipt,dict):
        raise ValueError("Invalid runner receipt.")
    version = receipt.get("format")
    if version == "papercolab-receipt-v2":
        fields.add("outputs")
    if set(receipt) != fields or version not in ("papercolab-receipt-v1","papercolab-receipt-v2"):
        raise ValueError("Invalid runner receipt.")
    if (receipt["runner"] != "docker-local-v1"
            or receipt["experiment_id"] != spec["id"] or receipt["bundle_sha256"] != bundle["sha256"]
            or receipt["image"] != spec["image"]):
        raise ValueError("Receipt does not match the pinned experiment.")
    status, code = receipt["status"], receipt["exit_code"]
    if status not in ("succeeded","failed","timeout","output-limit") or type(code) is not int or not -255 <= code <= 255:
        raise ValueError("Invalid execution status.")
    if (status == "succeeded") != (code == 0):
        raise ValueError("Exit status disagrees with outcome.")
    if type(receipt["elapsed_ms"]) is not int or not 0 <= receipt["elapsed_ms"] <= 180000:
        raise ValueError("Invalid execution duration.")
    log = receipt["log"]
    if not isinstance(log, str) or len(log.encode("utf-8")) > MAX_LOG or receipt["log_sha256"] != hashlib.sha256(log.encode("utf-8")).hexdigest():
        raise ValueError("Invalid log or log digest.")
    if version == "papercolab-receipt-v2":
        validate_outputs(receipt["outputs"])
        if status != "succeeded" and receipt["outputs"]:
            raise ValueError("Failed executions cannot publish structured outputs.")
        if status == "succeeded" and extract_outputs(log) != receipt["outputs"]:
            raise ValueError("Structured outputs do not match the recorded log.")
    return receipt
