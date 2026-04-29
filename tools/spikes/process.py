"""Batch crush every scraped input through its recommended default.

This is the "use it for real" mode, distinct from `pipeline.py` which
runs an 8-variant comparison grid for review.

Walks `tools/spikes/inputs/{curated,wikimedia,met}/<asset_type>/`,
applies the recommended config from the spike findings doc per
asset_type, writes one PNG per input under
`tools/spikes/out/processed/<asset_type>/`. Manifests record the source
file, the config used, and the SHA1 of the output.

Run:
    uv run --directory tools python -m spikes.process --asset-type card_back
    uv run --directory tools python -m spikes.process --all
"""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import logging
from pathlib import Path
from typing import Final

from PIL import Image

from spikes.crush import CrushConfig, crush
from spikes.pipeline import TARGETS, gather_inputs

OUT_ROOT = Path(__file__).resolve().parent / "out" / "processed"

log = logging.getLogger("spikes.process")

# Defaults per asset_type, mirroring the table in
# docs/spikes/image_pipeline_spike.md. Edit there + here together.
DEFAULTS: Final[dict[str, dict[str, object]]] = {
    "avatar": {
        "downsample": "nearest",
        "palette": "tokens",
        "dither": "fs",
        "vignette": True,
    },
    "background": {
        "downsample": "bilinear-then-nearest",
        "palette": "tokens",
        "dither": "fs",
        "vignette": True,
    },
    "texture": {
        "downsample": "nearest",
        "palette": "tokens",
        "dither": "bayer8",
    },
    "motif": {
        "downsample": "nearest",
        "palette": "tokens",
        "dither": "fs",
    },
    "card_back": {
        "downsample": "nearest",
        "palette": "tokens",
        "dither": "fs",
    },
}


def process_asset_type(asset_type: str) -> dict[str, object]:
    target = TARGETS[asset_type]
    cfg = CrushConfig(target_size=target, **DEFAULTS[asset_type])
    inputs = gather_inputs(asset_type)
    if not inputs:
        log.warning("no inputs for %s; run a scraper first", asset_type)
        return {
            "asset_type": asset_type,
            "config": dataclasses.asdict(cfg),
            "fingerprint": cfg.fingerprint(),
            "processed": [],
        }

    out_dir = OUT_ROOT / asset_type
    out_dir.mkdir(parents=True, exist_ok=True)
    log.info("processing %d %s inputs at %s with %s", len(inputs), asset_type, target, cfg.fingerprint())

    processed: list[dict[str, object]] = []
    for src in inputs:
        try:
            image = Image.open(src)
            crushed = crush(image, cfg)
        except Exception as exc:
            log.warning("crush failed for %s: %s", src.name, exc)
            processed.append({"input": str(src.name), "ok": False, "error": str(exc)})
            continue
        dest = out_dir / f"{src.stem}.png"
        crushed.save(dest)
        digest = hashlib.sha1(dest.read_bytes()).hexdigest()[:12]
        processed.append(
            {
                "input": str(src.name),
                "output": str(dest.relative_to(OUT_ROOT.parent)),
                "sha1": digest,
                "ok": True,
            }
        )

    manifest = {
        "asset_type": asset_type,
        "target": list(target),
        "config": dataclasses.asdict(cfg),
        "fingerprint": cfg.fingerprint(),
        "input_count": len(inputs),
        "output_count": sum(1 for p in processed if p.get("ok")),
        "processed": processed,
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(
        f"{asset_type}: {manifest['output_count']}/{manifest['input_count']} crushed -> {out_dir}"
    )
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--asset-type", choices=sorted(DEFAULTS))
    group.add_argument("--all", action="store_true", help="process every asset_type that has inputs")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )

    if args.all:
        any_outputs = False
        for asset_type in sorted(DEFAULTS):
            result = process_asset_type(asset_type)
            any_outputs = any_outputs or bool(result["output_count"])
        return 0 if any_outputs else 2

    process_asset_type(args.asset_type)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
