"""End-to-end runner: scrape -> crush -> grid.

Picks a small batch of inputs by asset type, runs a panel of crush
configurations, dumps a side-by-side comparison grid plus per-input
crushed PNGs.

Run:
    uv run --directory tools python -m spikes.pipeline \
        --asset-type avatar --count 3 --seed 7

Determinism: same `--seed` + same input bytes + same args -> same output
bytes. The seed only affects which inputs are picked when there are more
than `--count` available; once picked, crushing is fully deterministic.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from PIL import Image

from spikes import scrape_curated, scrape_wikimedia
from spikes.crush import CrushConfig, crush
from spikes.grid import Cell, make_grid
from spikes.http_client import HttpClient

INPUTS_ROOT = Path(__file__).resolve().parent / "inputs"
OUT_ROOT = Path(__file__).resolve().parent / "out"

log = logging.getLogger("spikes.pipeline")

TARGETS: dict[str, tuple[int, int]] = {
    "avatar": (64, 64),
    "background": (320, 180),
    "texture": (256, 256),
    "motif": (128, 128),
    "card_back": (96, 144),
}


@dataclass(frozen=True)
class CrushVariant:
    label: str
    cfg_kwargs: dict[str, object]


def variants_for(target_size: tuple[int, int]) -> list[CrushVariant]:
    """A panel of meaningful contrasts for review.

    Kept short on purpose: too many cells make the grid noisy. These
    cover the four big knobs from the ticket (downsample, palette,
    dither, post FX).
    """
    return [
        CrushVariant("tok+fs", {"downsample": "nearest", "palette": "tokens", "dither": "fs"}),
        CrushVariant("blur+tok+fs", {"downsample": "bilinear-then-nearest", "palette": "tokens", "dither": "fs"}),
        CrushVariant("tok+bayer8", {"downsample": "nearest", "palette": "tokens", "dither": "bayer8"}),
        CrushVariant("adapt32+fs", {"downsample": "nearest", "palette": "adaptive", "palette_size": 32, "dither": "fs"}),
        CrushVariant("adapt16+none", {"downsample": "nearest", "palette": "adaptive", "palette_size": 16, "dither": "none"}),
        CrushVariant("tok+fs+sat", {"downsample": "nearest", "palette": "tokens", "dither": "fs", "contrast": 1.25, "saturation": 1.1}),
        CrushVariant("tok+fs+vig", {"downsample": "nearest", "palette": "tokens", "dither": "fs", "vignette": True}),
        CrushVariant("tok+fs+scan+vig", {"downsample": "nearest", "palette": "tokens", "dither": "fs", "scanline": True, "vignette": True}),
    ]


def gather_inputs(asset_type: str) -> list[Path]:
    candidates: list[Path] = []
    for root in (
        INPUTS_ROOT / "curated" / asset_type,
        INPUTS_ROOT / "wikimedia" / asset_type,
        INPUTS_ROOT / "met" / asset_type,
    ):
        if root.is_dir():
            for path in sorted(root.iterdir()):
                if path.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".bmp"}:
                    candidates.append(path)
    return candidates


def ensure_inputs(asset_type: str, count: int, run_scrapers: bool) -> list[Path]:
    have = gather_inputs(asset_type)
    if have or not run_scrapers:
        return have
    log.info("no inputs for %s; running curated + wikimedia scrapers", asset_type)
    scrape_curated.main(["--asset-type", asset_type])
    client = HttpClient()
    if asset_type in scrape_wikimedia.WIKI_CATEGORIES:
        try:
            scrape_wikimedia.main(["--asset-type", asset_type, "--count", str(count)])
        except SystemExit:
            pass  # wikimedia track may legitimately produce 0 (robots-disallowed)
    _ = client  # placeholder; scrapers manage their own clients
    return gather_inputs(asset_type)


def load_image(path: Path) -> Image.Image:
    return Image.open(path)


def run(asset_type: str, count: int, seed: int, run_scrapers: bool, out_dir: Path) -> Path:
    target = TARGETS[asset_type]
    inputs = ensure_inputs(asset_type, count, run_scrapers)
    if not inputs:
        raise SystemExit(f"no inputs available for {asset_type}; run scrapers first")
    rng = random.Random(seed)
    if len(inputs) > count:
        rng.shuffle(inputs)
    inputs = inputs[:count]
    log.info("crushing %d %s inputs at %s", len(inputs), asset_type, target)

    variants = variants_for(target)
    rows: list[list[Cell]] = []
    digests: list[dict[str, str]] = []
    out_dir.mkdir(parents=True, exist_ok=True)

    # Cap displayed cell dimension at 160px (aspect-preserved) so grids
    # stay small enough to commit under docs/spikes/img/.
    cell_w = min(max(target[0], 96), 160)
    cell_h = round(target[1] * cell_w / target[0])
    cell_size = (cell_w, cell_h)
    for src in inputs:
        original = load_image(src)
        row = [Cell(label="original", image=original.convert("RGB"))]
        for variant in variants:
            cfg = CrushConfig(target_size=target, **variant.cfg_kwargs)
            crushed = crush(original, cfg)
            stem = f"{src.stem}__{variant.label}__{cfg.fingerprint()}.png"
            crushed_path = out_dir / stem
            crushed.save(crushed_path)
            digest = hashlib.sha1(crushed_path.read_bytes()).hexdigest()[:12]
            digests.append({"input": src.name, "variant": variant.label, "fingerprint": cfg.fingerprint(), "sha1": digest})
            row.append(Cell(label=variant.label, image=crushed))
        rows.append(row)

    grid_path = out_dir / f"grid__{asset_type}__seed{seed}.png"
    grid = make_grid(rows, cell_size)
    grid.save(grid_path, optimize=True)

    manifest = {
        "asset_type": asset_type,
        "count": count,
        "seed": seed,
        "target": list(target),
        "variants": [{"label": v.label, "kwargs": v.cfg_kwargs} for v in variants],
        "inputs": [str(p.relative_to(INPUTS_ROOT.parent.parent)) for p in inputs],
        "digests": digests,
        "grid": str(grid_path.relative_to(OUT_ROOT.parent.parent)),
    }
    (out_dir / f"manifest__{asset_type}__seed{seed}.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    print(f"wrote grid: {grid_path}")
    return grid_path


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--asset-type", required=True, choices=sorted(TARGETS))
    parser.add_argument("--count", type=int, default=3)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--no-scrape", action="store_true", help="use whatever inputs already exist")
    parser.add_argument("--out", type=Path, default=OUT_ROOT)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    run(
        asset_type=args.asset_type,
        count=args.count,
        seed=args.seed,
        run_scrapers=not args.no_scrape,
        out_dir=args.out,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
