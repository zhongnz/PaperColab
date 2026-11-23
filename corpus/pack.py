"""Repackage a downloaded arXiv TeX source archive as a ZIP without transforming file bytes."""
import argparse
import gzip
import io
from pathlib import Path
import stat
import tarfile
import zipfile

MIB = 1024 * 1024


def path_name(name):
    while name.startswith("./"):
        name = name[2:]
    if (not name or len(name) > 1024 or any(part in {"", ".", ".."} for part in name.split("/"))
            or any(c in name for c in ("\\", ":", "\0")) or any(ord(c) < 32 or ord(c) == 127 for c in name)):
        raise ValueError("Unsupported source path.")
    return name


def pack(source, output):
    if source.stat().st_size > 64 * MIB:
        raise ValueError("Source download exceeds 64 MiB.")
    raw = source.read_bytes()
    if raw.startswith(b"\x1f\x8b"):
        with gzip.GzipFile(fileobj=io.BytesIO(raw)) as stream:
            raw = stream.read(256 * MIB + 1)
    if len(raw) > 256 * MIB:
        raise ValueError("Expanded source exceeds 256 MiB.")
    stream = io.BytesIO(raw)
    try:
        tar = tarfile.open(fileobj=stream, mode="r:")
    except tarfile.ReadError:
        tar = None
    if tar is None and (b"\x00" in raw or (b"\\documentclass" not in raw and b"\\begin{document}" not in raw)):
        raise ValueError("Expected a TeX tar, gzipped source or standalone manuscript.")
    seen = set()
    count = 0
    total = 0

    def add(writer, name, data):
        nonlocal total
        name = path_name(name)
        if name in seen:
            raise ValueError("Duplicate source path.")
        seen.add(name)
        total += len(data)
        if total > 256 * MIB:
            raise ValueError("Combined sources exceed 256 MiB.")
        item = zipfile.ZipInfo(name)
        item.create_system = 3
        item.external_attr = (stat.S_IFREG | 0o644) << 16
        item.compress_type = zipfile.ZIP_DEFLATED
        writer.writestr(item, data)

    try:
        with output.open("xb") as destination:
            try:
                with zipfile.ZipFile(destination, "w") as writer:
                    if tar is None:
                        add(writer, "main.tex", raw)
                    else:
                        for item in tar:
                            count += 1
                            if count > 4000:
                                raise ValueError("Source archive exceeds 4,000 entries.")
                            if item.isdir():
                                continue
                            if not item.isreg() or item.size > 256 * MIB - total:
                                raise ValueError("Source contains a special file or exceeds the size limit.")
                            with tar.extractfile(item) as part:
                                add(writer, item.name, part.read())
                    if not seen:
                        raise ValueError("No source files in archive.")
                if destination.tell() > 64 * MIB:
                    raise ValueError("Result exceeds the validator's 64 MiB ZIP limit.")
            except BaseException:
                destination.close()
                output.unlink(missing_ok=True)
                raise
    finally:
        if tar is not None:
            tar.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    try:
        pack(args.source, args.output)
    except (OSError, EOFError, ValueError, tarfile.TarError) as error:
        parser.exit(1, str(error) + "\n")
