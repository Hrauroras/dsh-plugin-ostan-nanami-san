"""Visual diagnosis of the cut-out: mask, sprite on magenta, side by side.

Usage:
    python tools/diagnose_visual.py [state]
"""
from __future__ import annotations

import pathlib
import sys

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
OBJECTS = pathlib.Path(r"C:\Users\A2178\.dsh\attachments\v1\objects")
sys.path.insert(0, str(ROOT / "tools"))
from make_sprites import SOURCES, cut_out, paper_mask, distance_from_paper  # noqa: E402


def main() -> None:
    state = sys.argv[1] if len(sys.argv) > 1 else "idle"
    source = OBJECTS / SOURCES[state][:2] / SOURCES[state]
    image = Image.open(source).convert("RGB")
    rgb = np.asarray(image)

    core, paper = paper_mask(rgb)
    sprite = np.asarray(cut_out(image))
    alpha = sprite[..., 3]
    distance = distance_from_paper(rgb)

    panels = []
    panels.append(("source", Image.fromarray(rgb)))

    # The mask alone: red where the fill reached.
    mask_rgb = rgb.copy()
    mask_rgb[core] = (255, 0, 0)
    mask_rgb[paper & ~core] = (0, 160, 255)
    panels.append(("mask (red=paper, blue=rim)", Image.fromarray(mask_rgb)))

    # The final sprite over magenta.
    over = Image.new("RGBA", image.size, (255, 0, 255, 255))
    over.alpha_composite(Image.fromarray(sprite, "RGBA"))
    panels.append(("cut-out on magenta", over.convert("RGB")))

    # Alpha channel as greyscale.
    panels.append(("alpha", Image.fromarray(alpha).convert("RGB")))

    scale = 420 / image.height
    thumbs = []
    for label, panel in panels:
        thumb = panel.resize((max(1, round(panel.width * scale)), 420), Image.LANCZOS)
        thumbs.append((label, thumb))

    width = sum(t.width for _, t in thumbs) + 10 * (len(thumbs) - 1)
    sheet = Image.new("RGB", (width, 440), (24, 24, 28))
    x = 0
    for label, thumb in thumbs:
        sheet.paste(thumb, (x, 0))
        x += thumb.width + 10
    out = ROOT / "tools" / "diagnose-visual.png"
    sheet.save(out)

    # Numbers that decide it: how opaque is the character's own light artwork?
    blouse = (rgb.min(axis=2) > 200)
    print(f"{state}: paper {core.sum()} px, rim {(paper & ~core).sum()} px")
    print(f"  light artwork pixels (min channel >200): {int(blouse.sum())}")
    print(f"    of those, alpha==0  : {int((blouse & (alpha == 0)).sum())}")
    print(f"    of those, alpha<200 : {int((blouse & (alpha < 200)).sum())}")
    print(f"  distance stats inside the light artwork: "
          f"min {distance[blouse].min():.1f} median {np.median(distance[blouse]):.1f} max {distance[blouse].max():.1f}")
    print(f"  wrote {out}")


if __name__ == "__main__":
    main()
