"""Minimal ASAR reader: list entries and extract single files from app.asar.

Usage:
    python asar_tool.py list <asar> [substring]
    python asar_tool.py read <asar> <inner/path>
"""
from __future__ import annotations

import json
import pathlib
import struct
import sys


def read_header(handle):
    handle.seek(0)
    prefix = handle.read(16)
    if len(prefix) != 16:
        raise SystemExit("not an asar archive")
    # 4 bytes pickle size, 4 bytes header size, 4 bytes header-pickle size,
    # 4 bytes JSON length, then the JSON itself.
    header_size = struct.unpack("<I", prefix[4:8])[0]
    handle.seek(8)
    payload = handle.read(header_size)
    if len(payload) != header_size:
        raise SystemExit("truncated header")
    json_len = struct.unpack("<I", payload[4:8])[0]
    text = payload[8:8 + json_len].decode("utf-8")
    return json.loads(text), 8 + header_size


def walk(node, prefix, out):
    for name, entry in node.get("files", {}).items():
        path = f"{prefix}{name}"
        if "files" in entry:
            walk(entry, f"{path}/", out)
        else:
            out.append((path, int(entry.get("size", 0)), int(entry.get("offset", 0))))


def main() -> None:
    command, archive = sys.argv[1], pathlib.Path(sys.argv[2])
    header, data_start = read_header(archive.open("rb"))
    entries = []
    walk(header, "", entries)
    if command == "list":
        needle = sys.argv[3].lower() if len(sys.argv) > 3 else ""
        hits = [e for e in entries if needle in e[0].lower()]
        print(f"{len(entries)} entries, {len(hits)} matching {needle!r}")
        for path, size, _ in hits[:400]:
            print(f"{size:>10}  {path}")
        return
    if command == "read":
        wanted = sys.argv[3]
        for path, size, offset in entries:
            if path == wanted:
                with archive.open("rb") as handle:
                    handle.seek(data_start + offset)
                    sys.stdout.write(handle.read(size).decode("utf-8", "replace"))
                return
        raise SystemExit(f"not found: {wanted}")
    raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
