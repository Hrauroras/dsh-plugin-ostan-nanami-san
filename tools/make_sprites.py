"""Slice the four OStan Nanami-San reference poses into transparent pet sprites.

Source poses (normalized 1000x1500 JPEG copies supplied by the user):
  idle  <- image.jpg    front-facing, hands together, plain smile
  work  <- image4.jpg   finger raised, thinking pose
  wait  <- image3.jpg   hands clasped at the chin, eyes closed, shy
  cheer <- image2.jpg   both fists up, sparkle eyes, hopping

Why this is not a per-pixel "distance from white" threshold: the character is
drawn with large white areas — blouse, collar, sleeves, both thigh-high socks —
enclosed by dark line art. A global threshold punches those out as holes. Paper
white is only the region CONNECTED TO THE IMAGE BORDER, so this script floods
from the frame and leaves every enclosed white pixel opaque.

Output: assets/<state>.png at SPRITE_H tall, paper removed to alpha.
"""
from __future__ import annotations

import pathlib

import numpy as np
from PIL import Image

OBJECTS = pathlib.Path(r"C:\Users\A2178\.dsh\attachments\v1\objects")
ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "assets"

SOURCES = {
    "idle": "b660de3246741f3a034db11f7d7268030fce24efd079d20e69257604fb55e099",
    "work": "3fb05bbbd7efc3f3f40e551b41f74010a5cb624ddf841a629ba8bb73a0c8cb33",
    "wait": "2084f1459e7ad8e2f6d9469ca0a85fab0dd688b00441457c4137922c3834e90f",
    "cheer": "42d39bfc8d3b915d27488905cdc32dd3e9941a6a389df5abcecdf818b1f7d20c",
}

SPRITE_H = 520
PAD = 4

# Distance from the paper colour at which a pixel is definitely background.
CORE_DISTANCE = 34.0


def measure_background(rgb: np.ndarray) -> np.ndarray:
    """Median colour of the image border: the paper the drawing sits on."""
    corners = np.concatenate([
        rgb[0:8, 0:8].reshape(-1, 3),
        rgb[0:8, -8:].reshape(-1, 3),
        rgb[-8:, 0:8].reshape(-1, 3),
        rgb[-8:, -8:].reshape(-1, 3),
    ])
    return np.median(corners.astype(np.float32), axis=0)


def distance_from_paper(rgb: np.ndarray) -> np.ndarray:
    """Per-pixel Euclidean distance from the measured paper colour."""
    background = measure_background(rgb)
    return np.sqrt(((rgb.astype(np.float32) - background) ** 2).sum(axis=2))


def paper_mask(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(core, paper) masks: what the flood reached, and the same grown by its rim."""
    distance = distance_from_paper(rgb)
    core = distance < CORE_DISTANCE

    # Flood fill from every border pixel through the near-white core, keeping
    # only the component that touches the frame. Iterative 4-connected spread
    # (numpy shift + or); scipy is not part of the bundled runtime.
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
            break
        reached = grown

    return reached, reached


def cut_out(image: Image.Image) -> Image.Image:
    """RGBA image with the paper removed and enclosed white preserved.

    The alpha channel is the flood mask itself and nothing else. An earlier
    version added a "soft rim" plus a distance-proportional taper just outside
    the fill; that taper also thinned artwork pixels whose colour happens to sit
    near the paper colour, punching see-through holes through the blouse and
    both socks. Enclosed white and near-white artwork are exactly what this
    function exists to keep, so the mask stays binary and the paper's own
    anti-aliased edge is removed with it (it is paper, and it reads as paper at
    a 148 px display width).

    Growing the mask by a constant is not a fix either: it is a morphological
    dilation, so it bites at least as far into the artwork as the taper did.
    """
    rgb = np.asarray(image.convert("RGB"))
    core, _paper = paper_mask(rgb)
    alpha = np.where(core, 0, 255).astype(np.uint8)
    return Image.fromarray(np.dstack([rgb, alpha]).astype(np.uint8), "RGBA")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for state, digest in SOURCES.items():
        source = OBJECTS / digest[:2] / digest
        image = Image.open(source)
        cut = cut_out(image)

        bbox = cut.getbbox()
        if bbox is None:
            raise SystemExit(f"{state}: empty sprite after cut-out")
        cut = cut.crop(bbox)

        scale = SPRITE_H / cut.height
        target = (max(1, round(cut.width * scale)), SPRITE_H)
        sprite = cut.resize(target, Image.LANCZOS)

        padded = Image.new("RGBA", (target[0] + PAD * 2, target[1] + PAD * 2), (0, 0, 0, 0))
        padded.alpha_composite(sprite, (PAD, PAD))
        padded.save(OUT / f"{state}.png", optimize=True)

        # Report how much of the character's own white survived the cut: the
        # blouse and socks are the whole reason this script floods instead of
        # thresholding, so the number belongs in the build output.
        alpha = np.asarray(padded)[..., 3]
        rows, cols = np.nonzero(alpha > 40)
        box = alpha[rows.min():rows.max() + 1, cols.min():cols.max() + 1]
        enclosed_white = (np.asarray(padded)[rows.min():rows.max() + 1, cols.min():cols.max() + 1, :3].min(axis=2) > 235) & (box > 200)
        print(
            f"{state:6s} {str(image.size):>12} -> {str(padded.size):>10}  "
            f"kept bright pixels: {int(enclosed_white.sum()):>6}  {digest[:12]}"
        )


if __name__ == "__main__":
    main()
