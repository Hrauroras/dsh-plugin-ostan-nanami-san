"""Minimal comparison: which alpha construction actually preserves the artwork?

Renders, side by side:
  A. core-only        alpha = 0 where the flood reached, 255 elsewhere
  B. core + rim       ... plus a soft rim grown from the fill
  C. shipped cut_out  the current implementation in make_sprites.py

Usage:
    python tools/diagnose_alpha2.py
"""
from __future__ import annotations

import pathlib
import sys

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
OBJECTS = pathlib.Path(r"C:\Users\A2178\.dsh\attachments\v1\objects")
sys.path.insert(0, str(ROOT / "tools"))
from make_sprites import SOURCES, cut_out, distance_from_paper, paper_mask  # noqa: E402

CORE = 34.0
RIM = 4


def flood_from_border(core: np.ndarray) -> np.ndarray:
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


def grow(mask: np.ndarray, times: int) -> np.ndarray:
    out = mask
    for _ in range(times):
        spread = out.copy()
        spread[1:, :] |= out[:-1, :]
        spread[:-1, :] |= out[1:, :]
        spread[:, 1:] |= out[:, :-1]
        spread[:, :-1] |= out[:, 1:]
        if np.array_equal(spread, out):
            break
        out = spread
    return out


def on_magenta(rgb: np.ndarray, alpha: np.ndarray) -> Image.Image:
    base = Image.new("RGBA", (rgb.shape[1], rgb.shape[0]), (255, 0, 255, 255))
    layer = Image.fromarray(np.dstack([rgb, alpha]).astype(np.uint8), "RGBA")
    base.alpha_composite(layer)
    return base.convert("RGB")


def main() -> None:
    image = Image.open(OBJECTS / SOURCES["idle"][:2] / SOURCES["idle"]).convert("RGB")
    rgb = np.asarray(image)
    distance = distance_from_paper(rgb)

    # A: the plain, obvious construction.
    core = distance < CORE
    reached = flood_from_border(core)
    alpha_a = np.where(reached, 0, 255).astype(np.uint8)

    # B: A plus a rim, and a proportional taper just outside the rim.
    rim = grow(reached, RIM)
    alpha_b = np.where(reached, 0, 255).astype(np.float32)
    alpha_b[rim & ~reached] = 150
    outside = (~rim) & (distance < CORE * 2.5)
    alpha_b[outside] = 255 * np.clip((distance[outside] - CORE) / (CORE * 1.5), 0.0, 1.0)
    alpha_b = alpha_b.astype(np.uint8)

    # C: whatever make_sprites.py currently does.
    alpha_c = np.asarray(cut_out(image))[..., 3]

    panels = [
        ("A core-only", on_magenta(rgb, alpha_a)),
        ("B core+rim", on_magenta(rgb, alpha_b)),
        ("C shipped", on_magenta(rgb, alpha_c)),
    ]
    scale = 430 / rgb.shape[0]
    thumbs = [(label, panel.resize((max(1, round(panel.width * scale)), 430), Image.LANCZOS)) for label, panel in panels]
    width = sum(t.width for _, t in thumbs) + 10 * (len(thumbs) - 1)
    sheet = Image.new("RGB", (width, 430), (24, 24, 28))
    x = 0
    for _, thumb in thumbs:
        sheet.paste(thumb, (x, 0))
        x += thumb.width + 10
    out = ROOT / "tools" / "diagnose-alpha2.png"
    sheet.save(out)

    for label, alpha in (("A", alpha_a), ("B", alpha_b), ("C", alpha_c)):
        holes = int(((alpha < 8) & ~reached).sum())
        print(f"{label}: transparent-but-not-paper pixels = {holes}  (rim px {int((rim & ~reached).sum())})")
    print(f"paper (flood) pixels = {int(reached.sum())}")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
