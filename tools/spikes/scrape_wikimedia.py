"""Wikimedia Commons category-enumeration scrape track.

Queries the MediaWiki API for files in a category, then resolves each
file's URL via `imageinfo` and downloads. Writes to
`tools/spikes/inputs/wikimedia/<asset_type>/` plus a manifest JSON.

Run:
    uv run --directory tools python -m spikes.scrape_wikimedia \
        --asset-type avatar \
        --category Black_and_white_photographs_of_men \
        --count 6

Multiple categories per asset type are encoded in `WIKI_CATEGORIES` for
batch use from `pipeline.py`.
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

from spikes.http_client import UA, HttpClient

API = "https://commons.wikimedia.org/w/api.php"
OUT_ROOT = Path(__file__).resolve().parent / "inputs" / "wikimedia"
SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")

log = logging.getLogger("spikes.scrape_wikimedia")

# Categories chosen during spike discovery — at least 1 working category
# per asset type. Confirmed non-empty via probe before commit.
WIKI_CATEGORIES: Final[dict[str, tuple[str, ...]]] = {
    "avatar": ("Black_and_white_photographs_of_men", "Portrait_photographs"),
    "background": ("Constructivism_(art)", "Russian_avant-garde"),
    "texture": ("Wood_textures", "Stone_textures"),
    "motif": ("Constructivism_(art)", "Soviet_emblems"),
    "card_back": ("Playing_cards", "Backs_of_playing_cards"),
}


def list_category_files(client: HttpClient, category: str, count: int) -> list[str]:
    url = (
        f"{API}?action=query&format=json&list=categorymembers"
        f"&cmtitle=Category:{urllib.parse.quote(category)}"
        f"&cmtype=file&cmlimit={count}"
    )
    result = client.get(url)
    if result is None:
        return []
    payload = json.loads(result.body)
    members = payload.get("query", {}).get("categorymembers", [])
    return [m["title"] for m in members]


def resolve_imageinfo(client: HttpClient, titles: list[str]) -> list[dict[str, object]]:
    """Bulk imageinfo query — returns [{title, url, license_short}]."""
    if not titles:
        return []
    titles_param = "|".join(titles)
    url = (
        f"{API}?action=query&format=json&prop=imageinfo"
        f"&iiprop=url|extmetadata&iiurlwidth=800"
        f"&titles={urllib.parse.quote(titles_param)}"
    )
    result = client.get(url)
    if result is None:
        return []
    payload = json.loads(result.body)
    out: list[dict[str, object]] = []
    pages = payload.get("query", {}).get("pages", {}) or {}
    for page in pages.values():
        info_list = page.get("imageinfo")
        if not info_list:
            continue
        info = info_list[0]
        meta = info.get("extmetadata", {}) or {}
        license_short = meta.get("LicenseShortName", {}).get("value", "unknown")
        usage_terms = meta.get("UsageTerms", {}).get("value", "")
        url_field = info.get("thumburl") or info.get("url")
        out.append(
            {
                "title": page.get("title", ""),
                "url": url_field,
                "license": license_short,
                "usage_terms": usage_terms,
            }
        )
    return out


def download_one(client: HttpClient, asset_type: str, info: dict[str, object]) -> dict[str, object]:
    title = str(info["title"])
    url = str(info["url"])
    safe = SAFE_NAME.sub("_", title.removeprefix("File:")).strip("_")[:80]
    parsed = urllib.parse.urlsplit(url)
    ext = Path(parsed.path).suffix.lstrip(".").lower() or "jpg"
    if ext not in {"jpg", "jpeg", "png", "tif", "tiff", "webp", "gif", "bmp"}:
        ext = "jpg"
    dest = OUT_ROOT / asset_type / f"{safe}.{ext}"
    saved = client.save(url, dest)
    return {
        "title": title,
        "url": url,
        "license": info["license"],
        "usage_terms": info["usage_terms"],
        "saved_to": str(saved.relative_to(OUT_ROOT.parent.parent)) if saved else None,
        "ok": saved is not None,
    }


def license_ok(info: dict[str, object]) -> bool:
    short = str(info.get("license", "")).lower()
    return any(tag in short for tag in ("pd", "public domain", "cc0", "cc by", "cc-by"))


def fetch_category(
    client: HttpClient, asset_type: str, category: str, count: int
) -> list[dict[str, object]]:
    titles = list_category_files(client, category, count)
    if not titles:
        log.warning("category %s returned 0 files", category)
        return []
    infos = resolve_imageinfo(client, titles)
    out: list[dict[str, object]] = []
    for info in infos:
        if not info.get("url"):
            continue
        if not license_ok(info):
            log.info("skip non-PD/CC: %s (%s)", info["title"], info["license"])
            client.refusals.append(
                # type: ignore[arg-type]
                __import__("spikes.http_client", fromlist=["FetchRefusal"]).FetchRefusal(
                    url=str(info["url"]),
                    reason="non-image",
                    detail=f"license={info['license']}",
                )
            )
            continue
        out.append(download_one(client, asset_type, info))
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--asset-type", required=True, choices=sorted(WIKI_CATEGORIES))
    parser.add_argument("--category", default=None, help="override category")
    parser.add_argument("--count", type=int, default=6)
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument(
        "--allow-api",
        action="store_true",
        help=(
            "bypass robots.txt for the Wikimedia API endpoint. Wikimedia's UA"
            " policy at https://meta.wikimedia.org/wiki/User-Agent_policy"
            " authorises programmatic API consumers with a proper UA, which"
            " supersedes the generic /w/ disallow in robots.txt. Off by"
            " default; opt in only after reading the policy."
        ),
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )

    client = HttpClient(ignore_robots=args.allow_api)
    if args.allow_api:
        log.info("--allow-api set; bypassing robots.txt per Wikimedia UA policy")
    categories = (args.category,) if args.category else WIKI_CATEGORIES[args.asset_type]
    fetched: list[dict[str, object]] = []
    for category in categories:
        log.info("category=%s asset_type=%s count=%d", category, args.asset_type, args.count)
        fetched.extend(fetch_category(client, args.asset_type, category, args.count))
        if len([f for f in fetched if f.get("ok")]) >= args.count:
            break

    OUT_ROOT.mkdir(parents=True, exist_ok=True)
    manifest_dir = OUT_ROOT / args.asset_type
    manifest_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = manifest_dir / "manifest.json"
    payload = {
        "method": "wikimedia-category-enumeration",
        "user_agent": UA,
        "categories": list(categories),
        "asset_type": args.asset_type,
        "count_requested": args.count,
        "fetched": [m for m in fetched if m["ok"]],
        "refused": [m for m in fetched if not m["ok"]],
        "refusal_summary": client.refusal_summary(),
    }
    manifest_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    ok = sum(1 for m in fetched if m["ok"])
    print(f"wikimedia: {ok} files saved for {args.asset_type}")
    print(f"manifest: {manifest_path}")
    return 0 if ok else 2


if __name__ == "__main__":
    raise SystemExit(main())
