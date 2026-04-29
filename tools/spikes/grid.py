"""Side-by-side comparison grid composition.

Given (label, PIL image) cells and a uniform display size, lay them out
into a single PNG with optional per-row labels rendered in the
design-system text color. Used by `pipeline.py` to dump human-reviewable
spike output.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

from PIL import Image, ImageDraw, ImageFont

from spikes.palette import load_base_palette

CELL_GAP = 8
LABEL_HEIGHT = 18
ROW_GAP = 16
PADDING = 16


@dataclass(frozen=True)
class Cell:
    label: str
    image: Image.Image


def _font() -> ImageFont.ImageFont:
    try:
        return ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", 11)
    except OSError:
        return ImageFont.load_default()


def make_grid(rows: Sequence[Sequence[Cell]], cell_size: tuple[int, int]) -> Image.Image:
    if not rows:
        raise ValueError("grid requires at least one row")
    cols = max(len(row) for row in rows)
    cw, ch = cell_size
    width = PADDING * 2 + cols * cw + (cols - 1) * CELL_GAP
    row_height = LABEL_HEIGHT + ch
    height = PADDING * 2 + len(rows) * row_height + (len(rows) - 1) * ROW_GAP
    palette = load_base_palette()
    bg = palette["bg"]
    text = palette["text"]
    canvas = Image.new("RGB", (width, height), bg)
    draw = ImageDraw.Draw(canvas)
    font = _font()
    for ri, row in enumerate(rows):
        y = PADDING + ri * (row_height + ROW_GAP)
        for ci, cell in enumerate(row):
            x = PADDING + ci * (cw + CELL_GAP)
            draw.text((x, y), cell.label[:32], fill=text, font=font)
            display = cell.image.convert("RGB").resize(cell_size, resample=Image.Resampling.NEAREST)
            canvas.paste(display, (x, y + LABEL_HEIGHT))
    return canvas
