# Skin sources (DUR-22 spike)

Drop your own PNGs here, then run `pnpm assets:build` from the repo
root. The pipeline writes a packed atlas to
`apps/web/public/skins/atlas.{png,json}`.

## Expected files

| Path | Size | Notes |
|---|---|---|
| `cards/surface.png` | 96 x 144 | Plain card body. Pattern + tint + finish all render on top of this layer, so keep it neutral / off-white. |
| `cards/decoration.png` | 96 x 144 | Border + suit + future rank text on a transparent background. Renders above everything else, untouched by pattern or finish, so colors stay constant per-card. |
| `patterns/p0.png` ... `p7.png` | 24 x 24 each | Tilable motifs. Drawn on transparent background; the runtime overlays them between surface and decoration at the configured alpha. |

## Fallback

Any file you do not provide is replaced with a procedural placeholder
matching the original spike's procedural drawing. So you can drop in
just one custom pattern and leave the rest as placeholders.

## Output

The pipeline writes:

- `apps/web/public/skins/atlas.png` -- packed atlas (surface on the
  left, decoration on the right, pattern grid below)
- `apps/web/public/skins/atlas.json` -- frame metadata
  `{ cardSurface, cardDecoration, patterns: [...] }`

The web sandboxes (`?sandbox=skins`, `?sandbox=skins-tuner`) load the
atlas at boot if present, and fall back to procedural otherwise.
