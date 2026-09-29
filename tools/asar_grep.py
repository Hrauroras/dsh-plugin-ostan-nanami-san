"""Grep inside app.asar without extracting the whole archive.

Usage:
    python asar_grep.py <asar> <regex> [maxHits] [maxBytesPerFile]
"""
from __future__ import annotations

import json
import pathlib
import re
import struct
import sys


def read_header(handle):
    handle.seek(0)
    prefix = handle.read(16)
    header_size = struct.unpack("<I", prefix[4:8])[0]
    handle.seek(8)
    payload = handle.read(header_size)
    json_len = struct.unpack("<I", payload[4:8])[0]
    return json.loads(payload[8:8 + json_len].decode("utf-8")), 8 + header_size


def walk(node, prefix, out):
    for name, entry in node.get("files", {}).items():
        path = f"{prefix}{name}"
        if "files" in entry:
            walk(entry, f"{path}/", out)
        else:
            out.append((path, int(entry.get("size", 0)), int(entry.get("offset", 0))))


def main() -> None:
    archive = pathlib.Path(sys.argv[1])
    pattern = re.compile(sys.argv[2])
    max_hits = int(sys.argv[3]) if len(sys.argv) > 3 else 60
    max_bytes = int(sys.argv[4]) if len(sys.argv) > 4 else 900_000
    with archive.open("rb") as handle:
        header, data_start = read_header(handle)
        entries = []
        walk(header, "", entries)
        hits = 0
        for path, size, offset in entries:
            if size > max_bytes or not path.endswith((".js", ".mjs", ".cjs", ".json", ".yml", ".yaml", ".md")):
                continue
            handle.seek(data_start + offset)
            text = handle.read(size).decode("utf-8", "replace")
            for match in pattern.finditer(text):
                line_start = text.rfind("\n", 0, match.start()) + 1
                line_end = text.find("\n", match.end())
                line = text[line_start:line_end if line_end > 0 else len(text)]
                print(f"{path}:{text.count(chr(10), 0, match.start()) + 1}: {line.strip()[:220]}")
                hits += 1
                if hits >= max_hits:
                    print(f"... stopped at {max_hits} hits")
                    return


if __name__ == "__main__":
    main()
