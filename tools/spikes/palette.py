"""Load the design-system palette + small ramp extensions used by the crusher.

The base palette lives in `palette.json`, exported from
`packages/ui/src/tokens.ts` via `spikes.scripts.export_palette`. The
crusher needs more than ~14 raw colors to look good, so we synthesize
shade ramps around the base hues.
"""

from __future__ import annotations

import colorsys
import json
from pathlib import Path
from typing import Iterable, Sequence

PALETTE_JSON = Path(__file__).resolve().parent / "palette.json"

RGB = tuple[int, int, int]


def _hex_to_rgb(value: str) -> RGB:
    hexcode = value.lstrip("#")
    return (int(hexcode[0:2], 16), int(hexcode[2:4], 16), int(hexcode[4:6], 16))


def load_base_palette() -> dict[str, RGB]:
    payload = json.loads(PALETTE_JSON.read_text(encoding="utf-8"))
    return {name: _hex_to_rgb(value) for name, value in payload["colors"].items()}


def _ramp(rgb: RGB, steps: int) -> list[RGB]:
    r, g, b = (channel / 255.0 for channel in rgb)
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    lightnesses = [(i + 1) / (steps + 1) for i in range(steps)]
    out: list[RGB] = []
    for new_l in lightnesses:
        nr, ng, nb = colorsys.hls_to_rgb(h, new_l, s)
        out.append((round(nr * 255), round(ng * 255), round(nb * 255)))
    return out


def expanded_palette(ramp_steps: int = 4) -> list[RGB]:
    """Base hues + symmetric lightness ramps for each.

    With ramp_steps=4 over the 14 base entries, ends up around 70 colors,
    deduplicated. Designed for `Image.quantize(palette=...)` use.
    """
    base = list(load_base_palette().values())
    seen: set[RGB] = set()
    out: list[RGB] = []
    for rgb in base:
        candidates: Iterable[RGB] = (rgb, *_ramp(rgb, ramp_steps))
        for candidate in candidates:
            if candidate in seen:
                continue
            seen.add(candidate)
            out.append(candidate)
    return out


def palette_image(colors: Sequence[RGB]) -> "ImagePalette":
    """Build a Pillow palette image suitable for `Image.quantize(palette=)`.

    Pillow expects a 'P'-mode image whose palette contains exactly the
    colors we want. We pad to 256 with the last color so the palette is
    full-length.
    """
    from PIL import Image

    padded: list[RGB] = list(colors)
    if len(padded) > 256:
        padded = padded[:256]
    while len(padded) < 256:
        padded.append(padded[-1])
    flat: list[int] = []
    for rgb in padded:
        flat.extend(rgb)
    palette_img = Image.new("P", (1, 1))
    palette_img.putpalette(flat)
    return palette_img
