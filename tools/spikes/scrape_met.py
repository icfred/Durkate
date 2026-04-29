"""Met Museum Open Access scrape track.

The Metropolitan Museum of Art exposes a free no-key REST API at
`collectionapi.metmuseum.org`. ~492K objects are released under CC0.
This scraper fetches only objects with `isPublicDomain: True` and
saves the `primaryImage` (and optionally `additionalImages`) under
`tools/spikes/inputs/met/<asset_type>/`, plus a manifest with title,
artist, date, and license per entry.

Two input modes:
- explicit object IDs: `--ids 475536,475566` or repeated `--ids`.
- search query: `--search "playing cards" --limit 20`.

API endpoints used:
- /public/collection/v1/objects/{id}
- /public/collection/v1/search?q=...&hasImages=true

The Met's hosts have no robots.txt restrictions on the API or the
images CDN at images.metmuseum.org, so the default strict robots
behaviour fits.
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
import urllib.parse
from pathlib import Path
from typing import Final

from spikes.http_client import HttpClient

API = "https://collectionapi.metmuseum.org/public/collection/v1"
OUT_ROOT = Path(__file__).resolve().parent / "inputs" / "met"
SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")

log = logging.getLogger("spikes.scrape_met")

# Asset-type buckets are folder labels only; the API doesn't categorise.
# Use the spike's own asset_type vocabulary.
KNOWN_ASSET_TYPES: Final[tuple[str, ...]] = (
    "avatar",
    "background",
    "texture",
    "motif",
    "card_back",
)


def fetch_object(client: HttpClient, object_id: int) -> dict[str, object] | None:
    result = client.get(f"{API}/objects/{object_id}")
    if result is None:
        return None
    try:
        return json.loads(result.body)
    except json.JSONDecodeError:
        log.warning("non-json object response for id=%s", object_id)
        return None


def search_object_ids(client: HttpClient, query: str, has_images: bool) -> list[int]:
    params = {"q": query, "hasImages": "true" if has_images else "false"}
    result = client.get(f"{API}/search?{urllib.parse.urlencode(params)}")
    if result is None:
        return []
    payload = json.loads(result.body)
    ids = payload.get("objectIDs") or []
    return [int(i) for i in ids]


def safe_filename(record: dict[str, object], suffix_url: str) -> str:
    title = str(record.get("title") or "untitled")
    object_id = record.get("objectID")
    base = SAFE_NAME.sub("_", title).strip("_")[:60] or "untitled"
    ext = Path(urllib.parse.urlsplit(suffix_url).path).suffix.lstrip(".").lower() or "jpg"
    return f"{object_id}__{base}.{ext}"


def license_ok(record: dict[str, object]) -> bool:
    return bool(record.get("isPublicDomain"))


def download_object(
    client: HttpClient, asset_type: str, record: dict[str, object], include_addl: bool
) -> list[dict[str, object]]:
    if not license_ok(record):
        log.info("skip non-PD object %s (%s)", record.get("objectID"), record.get("title", "")[:60])
        return [
            {
                "objectID": record.get("objectID"),
                "title": record.get("title"),
                "ok": False,
                "reason": "not-public-domain",
            }
        ]
    primary_url = record.get("primaryImage")
    if not primary_url:
        return [
            {
                "objectID": record.get("objectID"),
                "title": record.get("title"),
                "ok": False,
                "reason": "no-primaryImage",
            }
        ]
    urls: list[str] = [str(primary_url)]
    if include_addl:
        urls.extend(str(u) for u in (record.get("additionalImages") or []) if u)

    saved: list[dict[str, object]] = []
    for url in urls:
        dest = OUT_ROOT / asset_type / safe_filename(record, url)
        path = client.save(url, dest)
        saved.append(
            {
                "objectID": record.get("objectID"),
                "title": record.get("title"),
                "artist": record.get("artistDisplayName"),
                "date": record.get("objectDate"),
                "license": "CC0 (Met Open Access)",
                "credit_line": record.get("creditLine"),
                "object_url": record.get("objectURL"),
                "image_url": url,
                "saved_to": str(path.relative_to(OUT_ROOT.parent.parent)) if path else None,
                "ok": path is not None,
            }
        )
    return saved


def parse_ids(values: list[str] | None) -> list[int]:
    out: list[int] = []
    for chunk in values or ():
        for piece in chunk.split(","):
            piece = piece.strip()
            if piece:
                out.append(int(piece))
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--asset-type",
        default="motif",
        choices=KNOWN_ASSET_TYPES,
        help="folder bucket under inputs/met/. The Met API doesn't categorise; you choose.",
    )
    parser.add_argument(
        "--ids",
        action="append",
        default=None,
        help='explicit object IDs, comma-separated or repeated. e.g. "--ids 475536,475566".',
    )
    parser.add_argument("--search", default=None, help="search query (used with --limit)")
    parser.add_argument("--limit", type=int, default=10, help="max objects to fetch from a search")
    parser.add_argument(
        "--include-additional",
        action="store_true",
        help="also save additionalImages for each object",
    )
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )

    client = HttpClient()
    ids: list[int] = []
    if args.ids:
        ids.extend(parse_ids(args.ids))
    if args.search:
        log.info("search %r limit=%d", args.search, args.limit)
        found = search_object_ids(client, args.search, has_images=True)
        log.info("search returned %d ids", len(found))
        ids.extend(found[: args.limit])
    if not ids:
        print("no object IDs to fetch; pass --ids or --search", file=sys.stderr)
        return 1

    saved_records: list[dict[str, object]] = []
    for object_id in ids:
        record = fetch_object(client, object_id)
        if record is None:
            saved_records.append({"objectID": object_id, "ok": False, "reason": "fetch-failed"})
            continue
        saved_records.extend(download_object(client, args.asset_type, record, args.include_additional))

    OUT_ROOT.mkdir(parents=True, exist_ok=True)
    manifest_dir = OUT_ROOT / args.asset_type
    manifest_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = manifest_dir / "manifest.json"
    payload = {
        "method": "met-open-access",
        "host": "collectionapi.metmuseum.org",
        "asset_type": args.asset_type,
        "search": args.search,
        "limit": args.limit,
        "object_ids": ids,
        "include_additional_images": args.include_additional,
        "fetched": [r for r in saved_records if r.get("ok")],
        "refused": [r for r in saved_records if not r.get("ok")],
        "refusal_summary": client.refusal_summary(),
    }
    manifest_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    ok_count = sum(1 for r in saved_records if r.get("ok"))
    print(f"met: {ok_count} files saved for {args.asset_type}")
    print(f"manifest: {manifest_path}")
    return 0 if ok_count else 2


if __name__ == "__main__":
    raise SystemExit(main())
