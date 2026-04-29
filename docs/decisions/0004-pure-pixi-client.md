# ADR-0004: Pure PixiJS client, no React

**Status:** Accepted
**Date:** 2026-04-29

## Context

The original stub mentioned React 19 + Vite for the client and ShadCN +
Tailwind v4 for menus. Vision priorities are: keyboard-centric controls
(arrow keys + enter + esc everywhere), Tetrio-feel snappy transitions,
custom design system, "cool and gamey" menus that feel continuous with the
in-game canvas. ShadCN was dropped early as wrong-shape for a game.

## Options considered

1. **React + PixiJS** with menus rendered as DOM and the table rendered to
   a canvas. The canvas + DOM seam complicates transitions between menu and
   game and forces two design systems.
2. **react-pixi** - React inside Pixi. Adds a render-cycle layer between
   game state and canvas. Rejected.
3. **Pure PixiJS** with menus and game rendered through the same Pixi
   pipeline. Tiny vanilla DOM overlay only when an HTML `<input>` is
   genuinely needed (player name, room code).

## Decision

Pure PixiJS. No React. `apps/web/src/main.ts` boots a Pixi app and Zustand
stores; screens are Pixi `Container`s swapped on phase change. A small
focus manager in `packages/ui/src/focus/` handles keyboard navigation.

Text input is handled by overlaying a transparent HTML `<input>` over the
focused Pixi field; ~30 lines of vanilla DOM, no framework.

## Consequences

- Menus and game share one rendering pipeline. Transitions between them are
  trivially Pixi animations.
- Custom design system is implemented as a Pixi UI kit
  (`packages/ui`) - `Button`, `Panel`, `Modal`, focus manager.
- Accessibility (screen readers, semantic HTML) is essentially zero. Flagged
  as acceptable for this project.
- Zustand is framework-agnostic; Pixi subscribes via `store.subscribe()`.
- One less dependency tree, no React reconciliation overhead, no DOM-canvas
  seam to fight.
- If the project ever needs heavy form/text-input UI, we revisit.
