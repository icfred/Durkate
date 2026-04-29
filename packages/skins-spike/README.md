# @durak/skins-spike

## Purpose

Throwaway architecture for the cosmetic-skin rendering spike (DUR-22).
Explores how an opaque short code maps to a visually distinct rendered
card, CSGO-style. The `-spike` suffix is intentional: this is not yet
load-bearing. The findings doc and ADR-0007 capture the recommended
shape for a real `@durak/skins` package.

## Public API

```ts
import { decode, rollCode, SkinCard, type SkinSpec, type Axes } from "@durak/skins-spike";
```

- `rollCode(rand): string` -- 12-char hex token, deterministic in
  the supplied RNG.
- `decode(code): SkinSpec` -- maps an opaque code to concrete render
  axes (pattern, tint, finish, motion).
- `SkinCard` -- Pixi `Container` that renders a card from a `SkinSpec`
  with axis toggles. Same code -> same render.

## Invariants

- Decode is a pure function. No `Math.random()`, no wall-clock reads.
- Same code, same axes-active set: same pixels (modulo motion phase).
- Motion is driven by `app.ticker` time fed in via `update(dtMs)`.

## Gotchas

- Custom WebGL filter; works in Pixi v8 only.
- Textures are generated procedurally on init -- a real package would
  load a baked atlas.
