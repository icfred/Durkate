# @durak/web

## Purpose

The browser client. Pure PixiJS app served by Vite. Renders menus, table,
HUD, and game-over screen all through one Pixi pipeline. Subscribes to
server state over websocket and to local Zustand stores for UI state.

## Key concepts

- **App phase**: top-level state machine - `MENU`, `LOBBY`, `IN_GAME`,
  `GAME_OVER`. Lives in a Zustand store; the renderer swaps screen
  Containers on phase change.
- **Screen**: a Pixi `Container` representing one app phase. Built from
  primitives in `@durak/ui`.
- **Game view store**: receives snapshots + events from the server and
  drives the table renderer.
- **Boot**: parses URL once for room links, initializes Pixi, mounts the
  initial screen, subscribes to ws.

## Public API

This is an app, not a library. Entry point: `src/main.ts`.

`main.ts` currently boots a `Pixi.Application` against `#app`,
constructs a placeholder "HELLO DURAK" panel from `@durak/ui`
primitives, and registers a single `Button` with a `FocusManager`.
The phase machine and Zustand stores wire in on top of this scaffold.

## Invariants

- No HTML UI components (no React, no Tailwind). Everything visible
  renders through Pixi.
- All keyboard nav goes through the FocusManager from `@durak/ui`.
- Game state changes never come from local logic - always from server
  messages.

## Gotchas

- Pixi is initialized once at boot and lives outside Zustand's React
  bindings. Subscribe to stores via `store.subscribe()` from inside Pixi
  containers.
- Text inputs use the `TextInputOverlay` helper from `@durak/ui` (vanilla
  DOM `<input>` overlay, no framework).

## Related ADRs

- ADR-0004: pure PixiJS client, no React
- ADR-0005: authoritative server with redacted snapshots and events
