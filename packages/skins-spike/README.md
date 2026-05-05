# @durak/skins-spike

## Purpose

Throwaway architecture for the cosmetic-skin rendering spike (DUR-22).
Explores how an opaque short code maps to a visually distinct rendered
card, CSGO-style. The `-spike` suffix is intentional: this is not yet
load-bearing. The findings doc and ADR-0007 capture the recommended
shape for a real `@durak/skins` package.

## Architecture: compose, not replace

`SkinnedCard` is a Pixi `Container` that **wraps** a base card primitive
(typically the in-game `CardView` from `apps/web/src/cards`) and layers
cosmetic effects on top. It does not draw a card from scratch. The
"no skin = default look" axiom: `applySkin(null)` removes all effects
and the wrapper renders identical to the bare base.

Spec axes map to mechanisms applied to the base:

| Axis      | Mechanism                                                       |
|-----------|-----------------------------------------------------------------|
| `tint`    | `ColorMatrixFilter` on the base (hue / saturation / brightness) |
| `finish`  | `foilFilter` (matte / foil / chrome / holographic) after tint   |
| `motion`  | Driven by `tick(timeSeconds)` — feeds `uTime` into the foil filter |
| `pattern` | `TilingSprite` overlay child sized to the base, above the base  |

`SkinnedCard` takes the base via constructor injection (rather than
constructing `CardView` itself) so the package stays free of any
workspace dependency on `@durak/web`. The sandboxes wire CardView and
SkinnedCard together.

## Public API

```ts
import {
  decode,
  rollCode,
  SkinnedCard,
  type SkinSpec,
  type Axes,
} from "@durak/skins-spike";
```

- `rollCode(rand): string` — 12-char hex token, deterministic in the
  supplied RNG.
- `decode(code): SkinSpec` — pure mapping from opaque code to render
  axes (pattern, tint, finish, motion).
- `SkinnedCard({ base, baseWidth, baseHeight, assets })` — wraps any
  Pixi `Container` and applies cosmetic effects.
- `applySkin(spec | null, axes?)` — `null` means no skin (bare base);
  `spec` paints on top of the base.
- `tick(timeSeconds)` — drives motion. Caller decides cadence.

## Invariants

- Decode is pure. No `Math.random()`, no wall-clock reads.
- Same code, same axes-active set: same pixels (modulo motion phase).
- `applySkin(null)` produces a bare base. Skin effects never leak
  across spec changes — re-applying replaces the prior effect set.

## Gotchas

- Custom WebGL filter; works in Pixi v8 only.
- `SkinAssets.cardSurface` and `SkinAssets.cardDecoration` are kept in
  the type for the asset pipeline but the new wrapper does not consume
  them — the base provides the card render.
- `baseWidth`/`baseHeight` size the pattern overlay; pass the actual
  on-screen dimensions of the base, not arbitrary atlas dimensions.
