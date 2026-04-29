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

- `Button({ label, width?, height?, onActivate? })` - Pixi `Container`,
  implements `Focusable`. Hover and keyboard focus share visuals;
  pointer click and `activate()` both fire `onActivate`.
- `Panel({ width, height, fill?, border?, borderWidth?, cornerRadius? })`
  - Pixi `Container`. `resize(w, h)` re-strokes the rect.
- `FocusManager({ onEscape?, target? })` - keyboard nav. `attach()` /
  `detach()` (re)bind keydown. `register(node)`, `unregister(node)`,
  `clear()`, `focusNext()`, `focusPrev()`. Routes arrow keys,
  Tab/Shift+Tab, Enter/Space, Escape.
- `Focusable` interface: `setFocus(focused)`, `activate()`.
- Tokens: `color`, `spacing`, `radius`, `stroke`, `typography`,
  `easing`, `duration`, plus the bundled `tokens` object and `Tokens`
  type. Soviet-dark palette per `docs/project_vision.md`.
- `Modal`, `ListItem`, `mountTextInputOverlay(...)` - planned, not yet
  implemented.

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

## Related ADRs

- ADR-0004: pure PixiJS client, no React
