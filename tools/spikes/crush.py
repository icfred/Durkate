"""Image crushing: downsample + palette quantize + dither + pre/post FX.

Pure-Pillow. Deterministic given the same input bytes + same `CrushConfig`.
The runner script is `pipeline.py`; this module exposes the building
blocks plus a single `crush(image, cfg)` entry point.

Run a one-off crush from the command line:
    uv run --directory tools python -m spikes.crush \
        --in inputs/curated/avatar/Lenin_in_Switzerland.jpg \
        --out out/lenin_crushed.png \
        --target 64x64 --palette tokens --dither fs
"""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import logging
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from PIL import Image, ImageEnhance, ImageFilter, ImageOps

from spikes.palette import expanded_palette, palette_image

log = logging.getLogger("spikes.crush")

DownsampleStrategy = Literal["nearest", "bilinear-then-nearest"]
PaletteStrategy = Literal["adaptive", "tokens"]
DitherKind = Literal["none", "fs", "bayer4", "bayer8"]


# ---- bayer matrices -----------------------------------------------------

BAYER4 = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
]

BAYER8 = [
    [0, 32, 8, 40, 2, 34, 10, 42],
    [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44, 4, 36, 14, 46, 6, 38],
    [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41],
    [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47, 7, 39, 13, 45, 5, 37],
    [63, 31, 55, 23, 61, 29, 53, 21],
]


@dataclass(frozen=True)
class CrushConfig:
    target_size: tuple[int, int]
    downsample: DownsampleStrategy = "nearest"
    palette: PaletteStrategy = "tokens"
    palette_size: int = 32  # only used when `palette` == "adaptive"
    dither: DitherKind = "fs"
    contrast: float = 1.0
    saturation: float = 1.0
    sharpen: bool = False
    outline: bool = False
    scanline: bool = False
    vignette: bool = False

    def fingerprint(self) -> str:
        """Stable digest used to name output files and validate determinism."""
        payload = "|".join(f"{k}={getattr(self, k)}" for k in sorted(dataclasses.asdict(self)))
        return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:10]


# ---- pre/post filters ---------------------------------------------------


def _preprocess(image: Image.Image, cfg: CrushConfig) -> Image.Image:
    out = image.convert("RGB")
    if cfg.saturation != 1.0:
        out = ImageEnhance.Color(out).enhance(cfg.saturation)
    if cfg.contrast != 1.0:
        out = ImageEnhance.Contrast(out).enhance(cfg.contrast)
    if cfg.sharpen:
        out = out.filter(ImageFilter.SHARPEN)
    return out


def _downsample(image: Image.Image, cfg: CrushConfig) -> Image.Image:
    target = cfg.target_size
    if cfg.downsample == "nearest":
        return image.resize(target, resample=Image.Resampling.NEAREST)
    # bilinear-then-nearest: smooth first to kill moiré, then snap to grid.
    smoothed = image.resize(target, resample=Image.Resampling.BILINEAR)
    return smoothed.resize(target, resample=Image.Resampling.NEAREST)


# ---- palette quantize ---------------------------------------------------


def _bayer_dither(image: Image.Image, matrix: list[list[int]]) -> Image.Image:
    """Add a thresholded ordered-dither pattern to the per-pixel value before
    quantize. Pillow doesn't expose ordered Bayer directly, so we shift each
    channel by a small offset based on (x % N, y % N) before snapping to the
    palette via NONE-dither quantize."""
    px = image.load()
    width, height = image.size
    n = len(matrix)
    span = n * n
    # amplitude is intentionally modest; too high and we lose contrast.
    amplitude = 24.0
    out = image.copy()
    out_px = out.load()
    for y in range(height):
        for x in range(width):
            cell = matrix[y % n][x % n]
            shift = ((cell + 0.5) / span - 0.5) * amplitude
            r, g, b = px[x, y][:3]
            out_px[x, y] = (
                max(0, min(255, int(r + shift))),
                max(0, min(255, int(g + shift))),
                max(0, min(255, int(b + shift))),
            )
    return out


def _quantize(image: Image.Image, cfg: CrushConfig) -> Image.Image:
    if cfg.palette == "adaptive":
        n = max(2, min(256, cfg.palette_size))
        if cfg.dither in ("bayer4", "bayer8"):
            matrix = BAYER4 if cfg.dither == "bayer4" else BAYER8
            shifted = _bayer_dither(image, matrix)
            return shifted.quantize(colors=n, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
        dither = Image.Dither.FLOYDSTEINBERG if cfg.dither == "fs" else Image.Dither.NONE
        return image.quantize(colors=n, method=Image.Quantize.MEDIANCUT, dither=dither)

    # fixed tokens palette
    fixed = palette_image(expanded_palette())
    if cfg.dither in ("bayer4", "bayer8"):
        matrix = BAYER4 if cfg.dither == "bayer4" else BAYER8
        shifted = _bayer_dither(image, matrix)
        return shifted.quantize(palette=fixed, dither=Image.Dither.NONE)
    dither = Image.Dither.FLOYDSTEINBERG if cfg.dither == "fs" else Image.Dither.NONE
    return image.quantize(palette=fixed, dither=dither)


# ---- post FX ------------------------------------------------------------


def _postprocess(image: Image.Image, cfg: CrushConfig) -> Image.Image:
    if image.mode != "RGB":
        out = image.convert("RGB")
    else:
        out = image.copy()
    if cfg.outline:
        edges = ImageOps.invert(out.convert("L").filter(ImageFilter.FIND_EDGES))
        edges_rgb = edges.convert("RGB")
        out = Image.blend(out, edges_rgb, 0.15)
    if cfg.scanline:
        px = out.load()
        for y in range(0, out.height, 2):
            for x in range(out.width):
                r, g, b = px[x, y]
                px[x, y] = (max(0, r - 18), max(0, g - 18), max(0, b - 18))
    if cfg.vignette:
        cx, cy = out.width / 2, out.height / 2
        max_d = (cx**2 + cy**2) ** 0.5
        px = out.load()
        for y in range(out.height):
            for x in range(out.width):
                d = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
                falloff = 1.0 - 0.6 * (d / max_d) ** 1.6
                falloff = max(0.45, falloff)
                r, g, b = px[x, y]
                px[x, y] = (int(r * falloff), int(g * falloff), int(b * falloff))
    return out


# ---- entry point --------------------------------------------------------


def crush(image: Image.Image, cfg: CrushConfig) -> Image.Image:
    pre = _preprocess(image, cfg)
    small = _downsample(pre, cfg)
    quantized = _quantize(small, cfg)
    return _postprocess(quantized.convert("RGB"), cfg)


# ---- CLI ----------------------------------------------------------------


def _parse_size(text: str) -> tuple[int, int]:
    parts = text.lower().split("x")
    if len(parts) != 2:
        raise argparse.ArgumentTypeError("expected WxH like 64x64 or 320x180")
    return int(parts[0]), int(parts[1])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--in", dest="src", required=True, type=Path)
    parser.add_argument("--out", dest="dest", required=True, type=Path)
    parser.add_argument("--target", required=True, type=_parse_size)
    parser.add_argument("--downsample", choices=("nearest", "bilinear-then-nearest"), default="nearest")
    parser.add_argument("--palette", choices=("tokens", "adaptive"), default="tokens")
    parser.add_argument("--palette-size", type=int, default=32)
    parser.add_argument("--dither", choices=("none", "fs", "bayer4", "bayer8"), default="fs")
    parser.add_argument("--contrast", type=float, default=1.0)
    parser.add_argument("--saturation", type=float, default=1.0)
    parser.add_argument("--sharpen", action="store_true")
    parser.add_argument("--outline", action="store_true")
    parser.add_argument("--scanline", action="store_true")
    parser.add_argument("--vignette", action="store_true")
    parser.add_argument("--seed", type=int, default=0, help="forwarded for hash-determinism check")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    cfg = CrushConfig(
        target_size=args.target,
        downsample=args.downsample,
        palette=args.palette,
        palette_size=args.palette_size,
        dither=args.dither,
        contrast=args.contrast,
        saturation=args.saturation,
        sharpen=args.sharpen,
        outline=args.outline,
        scanline=args.scanline,
        vignette=args.vignette,
    )
    image = Image.open(args.src)
    crushed = crush(image, cfg)
    args.dest.parent.mkdir(parents=True, exist_ok=True)
    crushed.save(args.dest)
    digest = hashlib.sha1(args.dest.read_bytes()).hexdigest()[:12]
    print(f"wrote {args.dest}  cfg={cfg.fingerprint()}  bytes-sha1={digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
