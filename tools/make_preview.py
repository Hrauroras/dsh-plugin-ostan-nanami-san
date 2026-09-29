"""Render docs/poses.png: the four packed poses on one labelled contact sheet.

Run from the package root:
    python tools/make_preview.py
"""
from __future__ import annotations

import pathlib

from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
DOCS = ROOT / "docs"

ORDER = [
    ("idle", "idle - resting", "待机"),
    ("work", "work - on the job", "干活中"),
    ("wait", "wait - needs your click", "在等你"),
    ("cheer", "cheer - finished", "完成啦"),
]

CELL_W, CELL_H = 340, 620
PAD = 24
LABEL_H = 54
BG = (247, 250, 255, 255)
INK = (27, 61, 117, 255)
MUTED = (107, 127, 158, 255)


def main() -> None:
    DOCS.mkdir(parents=True, exist_ok=True)
    width = CELL_W * 2 + PAD * 3
    height = (CELL_H + LABEL_H) * 2 + PAD * 3
    sheet = Image.new("RGBA", (width, height), BG)
    draw = ImageDraw.Draw(sheet)

    for index, (state, label_en, label_zh) in enumerate(ORDER):
        column = index % 2
        row = index // 2
        x = PAD + column * (CELL_W + PAD)
        y = PAD + row * (CELL_H + LABEL_H + PAD)

        draw.rounded_rectangle(
            (x, y, x + CELL_W, y + CELL_H + LABEL_H),
            radius=18,
            fill=(255, 255, 255, 255),
            outline=(214, 226, 243, 255),
            width=2,
        )
        sprite = Image.open(ASSETS / f"{state}.png")
        scale = min((CELL_W - 24) / sprite.width, (CELL_H - 16) / sprite.height)
        size = (max(1, round(sprite.width * scale)), max(1, round(sprite.height * scale)))
        sprite = sprite.resize(size, Image.LANCZOS)
        sheet.alpha_composite(sprite, (x + (CELL_W - size[0]) // 2, y + (CELL_H - size[1]) // 2 + 4))

        draw.text((x + 18, y + CELL_H + 8), label_en, fill=INK)
        draw.text((x + 18, y + CELL_H + 28), f"{label_zh}  ·  assets/{state}.png", fill=MUTED)

    out = DOCS / "poses.png"
    sheet.convert("RGB").save(out, optimize=True)
    print(f"{out} {sheet.size}")


if __name__ == "__main__":
    main()
