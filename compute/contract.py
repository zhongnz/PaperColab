"""Versioned portable experiment contract; hashes establish identity, not truth."""
import hashlib
import json
import re
import uuid

MAX_INPUT = 512 * 1024
MAX_LOG = 128 * 1024
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


def validate_receipt(receipt, bundle):
    spec = validate_bundle(bundle)
    if not isinstance(receipt, dict) or set(receipt) != {"format","experiment_id","bundle_sha256","image","runner","status","exit_code","elapsed_ms","log","log_sha256"}:
        raise ValueError("Invalid runner receipt.")
    if (receipt["format"] != "papercolab-receipt-v1" or receipt["runner"] != "docker-local-v1"
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
    return receipt
