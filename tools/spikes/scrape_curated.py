"""Curated direct-URL scrape track.

Reads `seed_urls.SEED`, fetches each via `HttpClient`, writes bytes to
`tools/spikes/inputs/curated/<asset_type>/<safe-name>.<ext>`, and dumps
a JSON manifest with license + status per entry.

Run:
    uv run --directory tools python -m spikes.scrape_curated [--asset-type avatar]
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
from dataclasses import asdict
from pathlib import Path

from spikes.http_client import HttpClient
from spikes.seed_urls import SEED, SeedEntry, by_type

OUT_ROOT = Path(__file__).resolve().parent / "inputs" / "curated"
SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")

log = logging.getLogger("spikes.scrape_curated")


def safe_filename(entry: SeedEntry) -> str:
    title = entry.title.removeprefix("File:")
    base, dot, ext = title.rpartition(".")
    if not dot or len(ext) > 5:
        base, ext = title, "jpg"
    base = SAFE_NAME.sub("_", base).strip("_")[:80] or "untitled"
    ext = ext.lower()
    return f"{base}.{ext}"


def fetch_entries(entries: list[SeedEntry], client: HttpClient) -> list[dict[str, object]]:
    manifest: list[dict[str, object]] = []
    for entry in entries:
        dest_dir = OUT_ROOT / entry.asset_type
        dest = dest_dir / safe_filename(entry)
        log.info("fetch %s -> %s", entry.title[:60], dest.name)
        result_path = client.save(entry.url, dest)
        manifest.append(
            {
                "asset_type": entry.asset_type,
                "title": entry.title,
                "url": entry.url,
                "license": entry.license,
                "notes": entry.notes,
                "saved_to": str(result_path.relative_to(OUT_ROOT.parent.parent)) if result_path else None,
                "ok": result_path is not None,
            }
        )
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--asset-type", default=None, help="filter to one asset type")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )

    grouped = by_type()
    targets = [grouped[args.asset_type]] if args.asset_type else list(grouped.values())
    entries = [entry for group in targets for entry in group]
    if not entries:
        print("no curated entries match filter", file=sys.stderr)
        return 1

    client = HttpClient()
    manifest = fetch_entries(entries, client)

    OUT_ROOT.mkdir(parents=True, exist_ok=True)
    manifest_path = OUT_ROOT / "manifest.json"
    payload = {
        "method": "curated-special-filepath",
        "host": "commons.wikimedia.org",
        "throttle_seconds": client.throttle_seconds,
        "fetched": [m for m in manifest if m["ok"]],
        "refused": [m for m in manifest if not m["ok"]],
        "refusal_summary": client.refusal_summary(),
    }
    manifest_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    ok = sum(1 for m in manifest if m["ok"])
    print(f"curated: {ok}/{len(manifest)} files saved")
    print(f"manifest: {manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
