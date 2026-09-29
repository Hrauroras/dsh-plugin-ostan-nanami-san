"""Diagnose the paper flood fill: where does it leak into the drawing?

Usage:
    python tools/diagnose_alpha.py [state]
"""
from __future__ import annotations

import pathlib
import sys

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
OBJECTS = pathlib.Path(r"C:\Users\A2178\.dsh\attachments\v1\objects")

SOURCES = {
    "idle": "b660de3246741f3a034db11f7d7268030fce24efd079d20e69257604fb55e099",
    "work": "3fb05bbbd7efc3f3f40e551b41f74010a5cb624ddf841a629ba8bb73a0c8cb33",
    "wait": "2084f1459e7ad8e2f6d9469ca0a85fab0dd688b00441457c4137922c3834e90f",
    "cheer": "42d39bfc8d3b915d27488905cdc32dd3e9941a6a389df5abcecdf818b1f7d20c",
}


def flood(core: np.ndarray) -> np.ndarray:
    reached = np.zeros_like(core)
    reached[0, :] = core[0, :]
    reached[-1, :] = core[-1, :]
    reached[:, 0] = core[:, 0]
    reached[:, -1] = core[:, -1]
    while True:
        grown = reached.copy()
        grown[1:, :] |= reached[:-1, :]
        grown[:-1, :] |= reached[1:, :]
        grown[:, 1:] |= reached[:, :-1]
        grown[:, :-1] |= reached[:, 1:]
        grown &= core
        if np.array_equal(grown, reached):
            return reached
        reached = grown


def main() -> None:
    state = sys.argv[1] if len(sys.argv) > 1 else "idle"
    image = Image.open(OBJECTS / SOURCES[state][:2] / SOURCES[state]).convert("RGB")
    rgb = np.asarray(image).astype(np.float32)
    height, width = rgb.shape[:2]

    corners = np.concatenate([
        rgb[0:8, 0:8].reshape(-1, 3), rgb[0:8, -8:].reshape(-1, 3),
        rgb[-8:, 0:8].reshape(-1, 3), rgb[-8:, -8:].reshape(-1, 3),
    ])
    paper = np.median(corners, axis=0)
    distance = np.sqrt(((rgb - paper) ** 2).sum(axis=2))
    print(f"{state}: source {width}x{height}, paper colour {paper.round(1).tolist()}")

    # How bright is the drawing's own light artwork, and how bright is the
    # outline that is supposed to seal it off?
    centre = distance[height // 4: height * 3 // 4, width // 4: width * 3 // 4]
    for threshold in (12, 16, 20, 24, 28, 34):
        core = distance < threshold
        reached = flood(core)
        # A leaking fill swallows most of the sheet; a correct one only the paper.
        fraction = reached.sum() / core.size
        print(f"  threshold {threshold:>3}: core {core.sum() / core.size:6.1%} of frame, filled {fraction:6.1%}")

    # Where is the leak? Look at the vertical line through the middle: report the
    # runs of "paper-reachable" pixels so an interior run is visible.
    core = distance < 20
    reached = flood(core)
    column = width // 2
    runs = []
    start = None
    for y in range(height):
        if reached[y, column] and start is None:
            start = y
        elif not reached[y, column] and start is not None:
            runs.append((start, y - 1))
            start = None
    if start is not None:
        runs.append((start, height - 1))
    print(f"  paper runs down column {column} (should be only the two margins):")
    for begin, end in runs:
        print(f"    rows {begin:>4}-{end:>4}  ({end - begin + 1} px)")

    # The narrowest passage the fill crossed: min distance along the boundary
    # between reached and unreached.
    border = reached & ~np.pad(reached, 1)[1:-1, 1:-1]
    print(f"  pixels on the fill boundary: {int(border.sum())}")


if __name__ == "__main__":
    main()
