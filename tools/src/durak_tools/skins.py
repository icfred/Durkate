"""Skin atlas pipeline (DUR-22 spike).

Reads source PNGs from `tools/skins/sources/` and bakes them into
`apps/web/public/skins/atlas.{png,json}` for the cosmetic-skin spike.

Sources expected:

    tools/skins/sources/cards/base.png         96 x 144
    tools/skins/sources/patterns/p0.png ...    24 x 24 each, p0..p7

If a source is missing, the pipeline falls back to a procedural
placeholder for that frame so the atlas is always complete. The web
runtime then loads the atlas via `Assets.load("/skins/atlas.png")`
and uses it as the texture source for `SkinCard`.

This module is throwaway alongside `@durak/skins-spike`. The
production pipeline will live under `packages/assets/src/generated/`
once the system stops being a spike (see ADR-0007).
"""

from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass
from pathlib import Path

from PIL import Image, ImageDraw

CARD_WIDTH = 96
CARD_HEIGHT = 144
TILE = 24
PATTERN_COUNT = 8

REPO_ROOT = Path(__file__).resolve().parents[3]
SOURCES_DIR = REPO_ROOT / "tools" / "skins" / "sources"
OUT_DIR = REPO_ROOT / "apps" / "web" / "public" / "skins"


@dataclass(frozen=True)
class Frame:
    x: int
    y: int
    w: int
    h: int


@dataclass(frozen=True)
class AtlasManifest:
    image: str
    card_surface: Frame
    card_decoration: Frame
    patterns: list[Frame]


def run() -> None:
    surface = _load_or_placeholder_surface(SOURCES_DIR / "cards" / "surface.png")
    decoration = _load_or_placeholder_decoration(SOURCES_DIR / "cards" / "decoration.png")
    patterns = [
        _load_or_placeholder_pattern(SOURCES_DIR / "patterns" / f"p{i}.png", i)
        for i in range(PATTERN_COUNT)
    ]

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest = _pack(surface, decoration, patterns, OUT_DIR / "atlas.png")
    (OUT_DIR / "atlas.json").write_text(
        json.dumps(
            {
                "image": manifest.image,
                "cardSurface": asdict(manifest.card_surface),
                "cardDecoration": asdict(manifest.card_decoration),
                "patterns": [asdict(f) for f in manifest.patterns],
            },
            indent=2,
        )
        + "\n"
    )
    print(f"skins: wrote {OUT_DIR / 'atlas.png'} and atlas.json")


def _pack(
    surface: Image.Image,
    decoration: Image.Image,
    patterns: list[Image.Image],
    out_png: Path,
) -> AtlasManifest:
    pattern_cols = 4
    pattern_rows = math.ceil(len(patterns) / pattern_cols)
    pattern_strip_w = pattern_cols * TILE
    pattern_strip_h = pattern_rows * TILE

    atlas_w = max(CARD_WIDTH * 2, pattern_strip_w)
    atlas_h = CARD_HEIGHT + pattern_strip_h
    atlas = Image.new("RGBA", (atlas_w, atlas_h), (0, 0, 0, 0))

    surface_frame = Frame(0, 0, CARD_WIDTH, CARD_HEIGHT)
    decoration_frame = Frame(CARD_WIDTH, 0, CARD_WIDTH, CARD_HEIGHT)
    atlas.paste(surface, (surface_frame.x, surface_frame.y))
    atlas.paste(decoration, (decoration_frame.x, decoration_frame.y))

    pattern_frames: list[Frame] = []
    for i, p in enumerate(patterns):
        col = i % pattern_cols
        row = i // pattern_cols
        x = col * TILE
        y = CARD_HEIGHT + row * TILE
        atlas.paste(p, (x, y))
        pattern_frames.append(Frame(x, y, TILE, TILE))

    atlas.save(out_png)
    return AtlasManifest(
        image="atlas.png",
        card_surface=surface_frame,
        card_decoration=decoration_frame,
        patterns=pattern_frames,
    )


def _load_or_placeholder_surface(path: Path) -> Image.Image:
    if path.exists():
        img = Image.open(path).convert("RGBA")
        return img.resize((CARD_WIDTH, CARD_HEIGHT)) if img.size != (CARD_WIDTH, CARD_HEIGHT) else img
    img = Image.new("RGBA", (CARD_WIDTH, CARD_HEIGHT), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle((0, 0, CARD_WIDTH - 1, CARD_HEIGHT - 1), radius=4, fill=(230, 224, 212, 255))
    return img


def _load_or_placeholder_decoration(path: Path) -> Image.Image:
    if path.exists():
        img = Image.open(path).convert("RGBA")
        return img.resize((CARD_WIDTH, CARD_HEIGHT)) if img.size != (CARD_WIDTH, CARD_HEIGHT) else img
    img = Image.new("RGBA", (CARD_WIDTH, CARD_HEIGHT), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle(
        (0, 0, CARD_WIDTH - 1, CARD_HEIGHT - 1), radius=4, outline=(207, 196, 173, 255), width=2
    )
    draw.rounded_rectangle(
        (6, 6, CARD_WIDTH - 7, CARD_HEIGHT - 7), radius=3, outline=(184, 169, 138, 255)
    )
    cx, cy = CARD_WIDTH // 2, CARD_HEIGHT // 2
    draw.polygon([(cx, cy - 22), (cx + 18, cy), (cx, cy + 22), (cx - 18, cy)], fill=(74, 63, 51, 217))
    draw.ellipse((cx - 4, cy - 4, cx + 4, cy + 4), fill=(230, 224, 212, 240))
    return img


def _load_or_placeholder_pattern(path: Path, index: int) -> Image.Image:
    if path.exists():
        img = Image.open(path).convert("RGBA")
        return img.resize((TILE, TILE)) if img.size != (TILE, TILE) else img
    img = Image.new("RGBA", (TILE, TILE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    ink = (255, 255, 255, 255)
    c = TILE // 2
    if index == 0:
        draw.ellipse((c - 2, c - 2, c + 2, c + 2), fill=ink)
    elif index == 1:
        draw.line([(0, TILE - 1), (TILE - 1, 0)], fill=ink, width=1)
    elif index == 2:
        draw.line([(0, 0), (TILE - 1, 0)], fill=ink, width=1)
        draw.line([(0, 0), (0, TILE - 1)], fill=ink, width=1)
    elif index == 3:
        draw.line([(c - 3, c), (c + 3, c)], fill=ink, width=1)
        draw.line([(c, c - 3), (c, c + 3)], fill=ink, width=1)
    elif index == 4:
        draw.polygon([(c, c - 4), (c + 4, c), (c, c + 4), (c - 4, c)], outline=ink)
    elif index == 5:
        prev = (0, c)
        for x in range(0, TILE + 1, 2):
            wy = c + int(round(math.sin((x / TILE) * 2 * math.pi) * 3))
            draw.line([prev, (x, wy)], fill=ink, width=1)
            prev = (x, wy)
    elif index == 6:
        for cx, cy in [(c, c), (0, 0), (TILE, 0), (0, TILE), (TILE, TILE)]:
            draw.ellipse((cx - 3, cy - 3, cx + 3, cy + 3), outline=ink)
    else:
        draw.line([(0, 0), (TILE - 1, TILE - 1)], fill=ink, width=1)
        draw.line([(0, TILE - 1), (TILE - 1, 0)], fill=ink, width=1)
    return img


if __name__ == "__main__":
    run()
