# Image scraping and crushing spike (DUR-24)

*Run 2026-04-29 against `main@55d0ae3`. Output is a prototype, not a
shipping asset catalog.*

Two coupled questions the spike was meant to answer:

- **(a)** Where can we cheaply source legally-clean inputs for each
  asset type, and what scraping mechanics actually work?
- **(b)** Given those inputs, what crushing pipeline produces output
  that looks at home in our Soviet pixel-art table, and what knobs do
  we expose to a future asset author?

All scripts live under `tools/spikes/` and run via
`uv run --directory tools python -m spikes.<name>`. No new Python deps
beyond Pillow (which was already in `tools/pyproject.toml`); HTTP uses
stdlib `urllib`. Stages: `scrape -> crush -> output`.

## Scrape findings

### Curated direct-URL track (`spikes.scrape_curated`)

**Verdict: works, recommended as the default.** Targets
`upload.wikimedia.org` directly with thumb URLs that pin width to 800px.
Robots-allowed (only `/wikipedia/commons/archive/` is disallowed).

Hit rate this run: 6/6 saved. Refusals: 0. Throttle: 600ms per host.
License logged per entry in `inputs/curated/manifest.json`.

The seed list (`tools/spikes/seed_urls.py`) is intentionally tiny — it
demonstrates the mechanic, not a shipping catalog. Each entry carries
`title`, `license`, optional `attribution`, and `notes`.

### Wikimedia category-enumeration track (`spikes.scrape_wikimedia`)

**Verdict: blocked by robots.txt for the `*` UA. Useful only with a
registered identity or as a one-off discovery step.**

`commons.wikimedia.org/robots.txt` disallows `/w/` and `/wiki/Special:`
for `User-agent: *`. The MediaWiki Action API lives at `/w/api.php`, so
both *category enumeration* and the *Special:FilePath* redirect
(originally planned for the curated track) are formally disallowed.

The script attempts the API, the HTTP client refuses per robots,
refusals are recorded in `inputs/wikimedia/<asset_type>/manifest.json`.
This run: 5 attempts, 5 refused (`refusal_summary: {"robots": 2}` per
asset type, after the API call is short-circuited by the robotparser).

Two ways to recover the API track in real work:

1. **Discovery-time, not scrape-time.** Run API queries by hand once,
   resolve titles to `upload.wikimedia.org` URLs, bake them into
   `seed_urls.py`. This is what we did to populate the curated list.
2. **Wikimedia UA policy.** Wikimedia explicitly authorises programmatic
   API access by clients that follow their User-Agent policy. A real
   scraper would carry a project-identifying UA, register a contact
   email, and document the API allowance in code, treating robots.txt
   as advisory for the API endpoint specifically. We did *not* take
   that route in the spike — the ticket said respect robots.txt.

Also observed: the API returns a "too many requests" HTML page after a
handful of curl probes within ~10s, even with a polite UA. So even with
robots permission, real ingest needs queue-aware backoff, not just a
fixed 500ms throttle.

### Hard-rule hygiene

- robots.txt fetched with our UA (the Python stdlib `RobotFileParser`
  defaults to `Python-urllib/x.y` which Wikimedia rejects 403; that
  causes the parser to treat the entire host as disallowed. We patched
  `HttpClient._robots_for` to fetch with our UA explicitly).
- Throttle: 600ms minimum between hits to the same host.
- 8 MiB hard cap per file; over-cap and non-image content-types log a
  refusal.
- License filter on the wikimedia track: anything without
  `pd|public domain|cc0|cc by|cc-by` in `LicenseShortName` is logged
  and skipped.

## Crush findings

Crushing pipeline order, per `spikes.crush.crush()`:

```
preprocess (saturation, contrast, sharpen)
  -> downsample (nearest, or bilinear-then-nearest)
  -> palette quantize (tokens fixed, or adaptive median-cut)
  -> dither (none / Floyd-Steinberg / Bayer 4x4 / Bayer 8x8)
  -> postprocess (1px outline blend, scanline, vignette)
```

Determinism: `crush(image, cfg)` is fully deterministic for a given
input + config. Verified by running the avatar pipeline twice and
comparing SHA1 hashes of the resulting PNG bytes — identical.

### What worked

Side-by-side grids in `docs/spikes/img/` (one per asset type, seed=7).
Reading them left to right against an `original` cell.

| Knob | Verdict |
|---|---|
| Token palette + Floyd-Steinberg (`tok+fs`) | **Default.** Best baseline cohesion with the Soviet palette across all four asset types. |
| Bilinear-then-nearest (`blur+tok+fs`) | Helpful on noisy inputs (matchbox labels, fabric textures). Not needed for portraits. |
| Bayer 8x8 (`tok+bayer8`) | Distinct ordered-dither feel. Good for "constructed" looking art (motifs, card backs). Wrong for portraits — feels like a print screen. |
| Adaptive 32 + FS (`adapt32+fs`) | Preserves source colour fidelity. Use when the original is *already* on-palette (sepia photographs, ochre posters). Loses cohesion when palette skews away from ours. |
| Saturation + contrast bump (`tok+fs+sat`) | Modest help on washed-out scans. Avoid above 1.4× — bands appear. |
| Vignette (`tok+fs+vig`) | Reads as "framed portrait" or "spotlit table". Good for avatars and backgrounds. Wrong for textures (visible falloff). |
| Scanline + vignette (`tok+fs+scan+vig`) | "CRT surveillance feed" effect. Good for backgrounds, overkill for everything else. |

### What broke

- **Adaptive 16 + no dither**: visible banding everywhere. Useful only
  as a "what does posterization look like" reference. Skip in production.
- **Token palette on highly-saturated reds (matchbox labels)**: the
  fixed palette has only `danger` (`#8b3a2b`) and `stamp` (`#a83232`)
  in the warm-red range, so red-dominant inputs collapse to a narrow
  band. The expanded palette ramps (lightness ramps around each base
  hue, ~70 colours total) help but only partially. **Action:** when we
  build the real catalog, the palette JSON should include 2–3
  intentional accent ramps (red, blue, green) the design system can
  also use, rather than relying purely on the current 14 entries.
- **Bayer 4x4** at small target sizes (64×64) creates a dot pattern
  that competes with the asset detail. 8x8 is finer and reads better.
- **Outline blend** was implemented but rendered weakly across all
  four asset types — the edges in our scanned source material are too
  soft for `FIND_EDGES` to bite. Skipped from the default panel.

## Recommended defaults per use case

| Asset type | Target | Default crush config | Notes |
|---|---|---|---|
| Avatar (portrait) | 64×64, 128×128 | `nearest + tokens + fs + vignette` | The vignette adds presence at small sizes. Saturation +10% on washed-out scans. |
| Background / scene | 320×180, 480×270 | `bilinear-then-nearest + tokens + fs + vignette` | Pre-blur tames busy source detail before snapping to grid. |
| Texture | 256×256 | `nearest + tokens + bayer8` | Bayer keeps the "hand-printed" feel; FS would smooth the grain. |
| Motif / decorative | 64×64 to 256×256 | `nearest + tokens + fs` | Tile-friendly. Skip vignette/scanline. |
| Card-back inspiration | 96×144 | (no curated examples in this spike) | Catalog is empty; needs a source pass before recommending a default. |

## Determinism gate

The pipeline writes per-input crushed PNGs and a manifest with
`sha1` digests:

```
inputs:  inputs/curated/avatar/Lenin_in_Switzerland.jpg
variant: tok+fs
fingerprint: 2c759a4c19  (cfg digest)
sha1: dbe166f08276...
```

Re-running `python -m spikes.pipeline --asset-type avatar --count 1
--seed 7 --no-scrape` yields the same grid SHA1
(`a8bcd931c5e0a0c1774de0a2adfd034d28c4d68a`) twice. The seed only
shuffles input ordering when more inputs exist than `--count`.

## Follow-up tickets to sketch

1. **Wire the spike's crush defaults into
   `tools/src/durak_tools/converter.py`.** Take the
   `nearest + tokens + fs` baseline plus per-asset-type overrides (the
   table above) into a real `convert(input_path, asset_type) -> PNG`
   entry point. Pillow imports already exist there; this is plumbing.
2. **Extend the tokens palette with accent ramps before any avatar
   crushing ships.** Today the 14-entry palette flattens warm-red
   inputs. Add `accentRed`, `accentTeal`, `accentDeep` (working names)
   to `packages/ui/src/tokens.ts` so the design system and the crusher
   share one source of truth.
3. **Wire `tools/src/durak_tools/scraper.py` to the curated
   direct-URL workflow.** Lift the `SeedEntry`/`HttpClient` shape from
   `spikes/`, add a JSON manifest format the converter consumes, drop
   the wikimedia-API track from scope (or gate it behind an explicit
   `--with-api` flag plus a UA registered with Wikimedia).
4. **Card-back source pass.** Curate a small set of PD card-back
   patterns (Wikimedia category `Backs_of_playing_cards` exists but was
   empty in our discovery; alternatives: heraldic ornament SVGs,
   pre-1928 advertising borders).
5. **Palette JSON export as part of `pnpm assets:build`.** Today
   `spikes.scripts.export_palette` is a one-shot. Move it into
   `tools/src/durak_tools/__main__.py:build` so the JSON regenerates
   any time tokens change, and the converter never reads `.ts`.

## Reproducing this spike

```
# scrape (real network, ~3s)
uv run --directory tools python -m spikes.scrape_curated

# crush + grid for one asset type
uv run --directory tools python -m spikes.pipeline \
  --asset-type avatar --count 1 --seed 7 --no-scrape

# regenerate the palette JSON if tokens.ts changes
uv run --directory tools python -m spikes.scripts.export_palette
```

Sample grids: `docs/spikes/img/grid__<asset_type>__seed7.png`.

## Why no new dependency

Pillow was already in `tools/pyproject.toml`. HTTP uses stdlib
`urllib.request` + `urllib.robotparser`; `httpx` was the alternative
but adding a dep for a few GETs and one robots check wasn't justified
for an exploratory spike. If real ingest grows beyond a single host,
async + `httpx` (or `requests-throttler`) is the obvious upgrade.
