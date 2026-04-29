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

- `Button`, `Panel`, `Modal`, `ListItem`, ... (Pixi `Container` subclasses)
- `FocusManager` class
- `tokens` (color, spacing, typography, easing)
- `mountTextInputOverlay(targetRect, opts)`

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

## Related ADRs

- ADR-0004: pure PixiJS client, no React
