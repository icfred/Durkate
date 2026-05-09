# @durak/ui

## Purpose

The Pixi UI kit and design system primitives. Container-based components
and a focus manager used by `apps/web` for menus, HUD, and in-game UI.
This package replaces what would normally be a HTML component library
(ShadCN, etc.) - everything renders to canvas via Pixi.

## Key concepts

- **Component**: a `Container` subclass with a stable layout API and
  consistent visual language. Examples: `Button`, `Panel`, `Modal`,
  `ListItem`.
- **FocusManager**: keyboard nav controller. Maintains a list of focusable
  nodes per screen, current index, and routes arrow keys / enter / esc to
  the active node.
- **Tokens**: typography, color, spacing, easing - the design system's
  primitive values, used consistently by every component.
- **TextInputOverlay**: a tiny vanilla DOM `<input>` overlaid on a focused
  Pixi field for actual text entry. ~30 lines of plain DOM, no framework.

## Public API

### Form primitives

- `Stack({ direction: "vertical" | "horizontal", gap? })` - container
  that auto-positions children with consistent spacing. `add(child)`
  drops the child at the next slot; `relayout()` reflows after a child
  resizes. Replaces hand-rolled `y += height + gap` cursors.
- `LabelRow({ label, control, width, height? })` - one settings row:
  left-aligned uppercase label, right-aligned control. Vertical centering
  is automatic so cycles, steppers, and toggles all line up.
- `SectionHeader(text)` - red small-caps section label. Place above a
  `Stack` of `LabelRow`s.
- `Cycle<T>({ values, value, onChange, format?, width?, height? })` -
  `< VALUE >` picker. Click halves to step, ArrowLeft/Right when focused
  do the same. Wraps both directions.
- `NumberStepper({ value, min?, max?, step?, format?, onChange, ... })` -
  Pixi-native numeric stepper. Click halves to decrement / increment;
  hold to repeat. ArrowDown/Up when focused.
- `ToggleChip({ label, active, onChange, width?, height? })` - on/off
  pill. Use to gate a section or to bundle inline boolean flags. For
  form-level booleans inside a stack, prefer a `Cycle` of `["ON","OFF"]`
  so they line up with the surrounding controls.

### Anim primitives

- `tween`, `moveTo`, `fadeTo`, `scaleTo`, `sequence`, `parallel` and
  the easings (`linear`, `easeInQuad`, `easeOutQuad`, `easeInOutCubic`,
  `easeOutBack`). Composable, ticker-driven. Each helper returns a
  `TweenHandle` with `cancel()`.

### Shell

- `Button({ label, width?, height?, onActivate? })` - Pixi `Container`,
  implements `Focusable`. Hover and keyboard focus share visuals.
- `Panel({ width, height, fill?, border?, borderWidth?, cornerRadius? })`
  - Pixi `Container`. `resize(w, h)` re-strokes the rect.
- `FocusManager({ onEscape?, target? })` - keyboard nav. `attach()` /
  `detach()` bind keydown. `register(node)`, `focusNext()`, `focusPrev()`,
  `suspend()`/`resume()`, escape & activate subscriptions. Use
  `suspend()` while a DOM overlay (e.g. `mountTextInputOverlay`) owns
  the keyboard.
- `Focusable` interface: `setFocus(focused)`, `activate()`.
- `mountTextInputOverlay({ targetRect, value?, onChange?, onSubmit?,
  onCancel?, focus? })` - transparent absolute-positioned `<input>`
  on `document.body`. Returns `{ unmount() }`.

### Tokens

`color`, `spacing`, `radius`, `stroke`, `typography`, `easing`,
`duration`, plus the bundled `tokens` object and `Tokens` type. Soviet
Dusk palette - `.claude/skills/durak-design/colors_and_type.css` is
canonical.

## Building a settings panel

The form primitives compose into one shape - a `Panel` containing a
vertical `Stack` of `SectionHeader` + `Stack` of `LabelRow`s:

```ts
const panel = new Panel({ width: 380, height: 600 });
const root = new Stack({ direction: "vertical", gap: spacing.sm });
panel.addChild(root);

root.add(new SectionHeader("PATTERN"));
const pattern = new Stack({ direction: "vertical", gap: 0 });
pattern.add(new LabelRow({
  label: "INDEX",
  control: new Cycle({ values: ["P0","P1","P2"], value: "P0", onChange }),
  width: 340,
}));
pattern.add(new LabelRow({
  label: "SCALE",
  control: new NumberStepper({ value: 1, min: 0, max: 3, step: 0.05, onChange }),
  width: 340,
}));
root.add(pattern);
```

Rules of thumb:
- One `SectionHeader` per group; bare labels never live next to the
  header. Use `LabelRow` for everything inside.
- Pick the spacing token, not raw px: `spacing.xs` (4) between rows in
  a section; `spacing.md` (16) between sections.
- Controls own their own width. `LabelRow` right-aligns them. Don't try
  to set `control.x` yourself.
- For toggles, prefer `Cycle<["ON","OFF"]>` inside a `LabelRow` over
  `ToggleChip`. The chip is for inline groups (e.g. the AXES bar in the
  tuner), not form rows.

## Invariants

- No HTML component libraries. Everything visible in a screen renders
  through Pixi.
- Every interactive component is keyboard-reachable via the FocusManager.
- Tokens are the single source of truth for color/spacing/typography. No
  inline magic numbers.

## Gotchas

- Pixi text rendering is less ergonomic than HTML text (no kerning niceties,
  no copy/paste). Plan around it.
- Accessibility (screen readers) is essentially zero. Acceptable for this
  project.
- Pixi `Container` reserves `label` as an internal field, so the
  `Button` constructor option is `label` but the internal text node is
  named differently. Don't rename it back without checking Pixi.
- `mountTextInputOverlay` lives on `document.body` in DOM coordinates,
  while Pixi renders on the canvas. Pass screen-space coordinates for
  `targetRect`, not Pixi local-space. Unmount before swapping screens
  or the overlay leaks across navigations.

## Related ADRs

- ADR-0004: pure PixiJS client, no React
