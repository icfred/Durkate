"""Curated direct-URL seed list for the curated-scrape track.

Targets `upload.wikimedia.org` directly because:

1. `commons.wikimedia.org/wiki/Special:` and `/w/api.php` are
   robots-disallowed for the `*` UA (see spike findings).
2. `upload.wikimedia.org` only disallows `/wikipedia/commons/archive/`,
   so direct-thumb URLs are robots-allowed.
3. Thumb URLs with explicit width pin file size, useful for the spike's
   "small batch" workflow.

URLs were resolved once via `imageinfo` during spike discovery. Each
entry carries license + attribution so the scraper writes a manifest
alongside the bytes. If a URL 404s the scraper logs a refusal.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Final


@dataclass(frozen=True)
class SeedEntry:
    asset_type: str
    url: str
    title: str
    license: str
    attribution: str = ""
    notes: str = ""


# All entries below are PD or CC0 per Wikimedia metadata at discovery time.
# `Public domain` License-Short-Name is mirrored in the `license` field.
SEED: Final[tuple[SeedEntry, ...]] = (
    # ---- avatars / portraits ----
    SeedEntry(
        asset_type="avatar",
        url="https://upload.wikimedia.org/wikipedia/commons/thumb/6/65/Lenin_in_Switzerland.jpg/960px-Lenin_in_Switzerland.jpg",
        title="Lenin in Switzerland.jpg",
        license="Public domain",
        attribution="Unknown / pre-1928 photographer",
        notes="Soviet-era portrait, fits the aesthetic theme.",
    ),
    # ---- backgrounds / scenes ----
    SeedEntry(
        asset_type="background",
        url="https://upload.wikimedia.org/wikipedia/commons/5/52/Matchbox_label_-_Abstract_Face_%28circa_1920s%29_-_MBP1472831980.jpg",
        title="Matchbox label - Abstract Face (circa 1920s) - MBP1472831980.jpg",
        license="Public domain",
        notes="Constructivist matchbox label",
    ),
    SeedEntry(
        asset_type="background",
        url="https://upload.wikimedia.org/wikipedia/commons/0/04/Matchbox_label_-_Abstract_Geometric_-_Czechoslovakia_%28circa_1920s%29_-_MBP1628322343.jpg",
        title="Matchbox label - Abstract Geometric - Czechoslovakia (circa 1920s) - MBP1628322343.jpg",
        license="Public domain",
    ),
    # ---- textures ----
    SeedEntry(
        asset_type="texture",
        url="https://upload.wikimedia.org/wikipedia/commons/thumb/4/4b/16_wood_samples.jpg/960px-16_wood_samples.jpg",
        title="16 wood samples.jpg",
        license="Public domain",
        notes="Wood texture sampler",
    ),
    # ---- motifs ----
    SeedEntry(
        asset_type="motif",
        url="https://upload.wikimedia.org/wikipedia/commons/3/3a/Matchbox_label_-_Abstract_Flame_%28circa_1920s%29_-_MBP1472735678.jpg",
        title="Matchbox label - Abstract Flame (circa 1920s) - MBP1472735678.jpg",
        license="Public domain",
    ),
    SeedEntry(
        asset_type="motif",
        url="https://upload.wikimedia.org/wikipedia/commons/9/9e/Matchbox_label_-_Abstract_Faces_-_Czechoslovakia_%28circa_1940s%29_-_MBP1420025989.jpg",
        title="Matchbox label - Abstract Faces - Czechoslovakia (circa 1940s) - MBP1420025989.jpg",
        license="Public domain",
    ),
    # ---- card-back inspiration ----
    # Curated discovery did not yield a clean upload-URL match before the
    # API rate-limited us. The wikimedia-category track is the second source.
)


def by_type() -> dict[str, list[SeedEntry]]:
    out: dict[str, list[SeedEntry]] = {}
    for entry in SEED:
        out.setdefault(entry.asset_type, []).append(entry)
    return out
