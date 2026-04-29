# @durak/web

## Purpose

The browser client. Pure PixiJS app served by Vite. Renders menus, table,
HUD, and game-over screen all through one Pixi pipeline. Subscribes to
server state over websocket and to local Zustand stores for UI state.

## Key concepts

- **App phase**: top-level state machine - `menu`, `lobby`, `game`,
  `gameover`. Lives in the `appStore` Zustand store; `ScreenRouter` swaps
  screen `Container`s when phase, mode, or room code changes.
- **Screen**: a Pixi `Container` that implements `layout(viewW, viewH)`
  and `dispose()`. Owns its own `FocusManager`. Built from primitives in
  `@durak/ui`.
- **ScreenRouter**: subscribes to `appStore`, rebuilds the active screen
  on relevant state change, calls `dispose()` + `destroy()` on the old
  screen before mounting the new one. No fade by default - matches the
  Tetrio-feel snappy swap.
- **URL hash**: on boot, `#room=ABCD` deep-links into the lobby with the
  code prefilled and `mode = "friend"`.
- **Boot**: awaits `@fontsource/jetbrains-mono` via `document.fonts.load`
  so Pixi text renders in the right family, then initializes Pixi,
  parses `#room=…`, starts the router. A font-load failure logs a
  warning and falls back to `"Courier New", monospace`.
- **Connection**: `createConnectionController` subscribes to
  `appStore.phase` and opens a single websocket while the user is in
  `lobby` or `game`; closing on return to `menu` or `gameover`. Status
  drives `appStore.connection`; `submitAction` flows through the
  controller-registered sender.

## Sandbox

`?sandbox=game` boots straight into `GameScreen` against a hand-rolled
fixture `Snapshot`, bypassing the lobby. Pick a fixture with
`?sandbox=game&fixture=<name>`; valid names are `fresh`, `midround`,
`takepile`, `gameover`. Defaults to `fresh`. Useful for visual review
without a server. Actions go to the no-op `submitAction` (logs a warning
in the console) until the ws-client is wired.

## Boot flow

`src/main.ts`:

1. Loads JetBrains Mono and waits for the regular and bold weights.
2. Creates the Pixi `Application` against `#app`.
3. Parses `window.location.hash` for `#room=…`. If present, transitions
   the store to `lobby` before the router starts.
4. Builds the `ScreenRouter` with a factory keyed on `state.phase`:
   - `menu` -> `MainMenuScreen`
   - `lobby` -> `LobbyScreen`
   - `game` -> `GameScreen` (renders `appStore.snapshot`)
   - `gameover` -> `PlaceholderScreen` (rematch UI is a later ticket).
5. Calls `router.setView(width, height)` and `router.start()`. Re-runs
   `setView` on Pixi `resize`.

## Networking

- `src/net/wsClient.ts` owns the raw websocket. `connect()` returns a
  `{ send, close }` handle and dispatches inbound frames into typed
  handlers. Outbound `ClientMessage` is validated with
  `clientMessageSchema`; inbound `ServerMessage` is parsed with
  `serverMessageSchema` from `@durak/protocol`. Bad frames close the
  socket with code `4400`; the local close uses code `4000`.
- **Reconnect**: on unexpected close, the client retries with
  exponential backoff (`100ms * 2^(n-1)`, capped at 5000ms). Up to 5
  attempts, then it surfaces `status: "error"`. A `4400` close is
  terminal - no reconnect.
- **Status surface**: handlers receive
  `(status, { attempts, error? })`; the connection controller forwards
  this into `appStore.connection`. There is no separate observable -
  consumers read the store. This was chosen over a `status$` subject
  because the store already has the right shape for downstream UI.
- `src/net/connection.ts` reconciles store phase with an active
  connection: lobby/game opens (or no-ops if already open for the same
  room), menu/gameover closes. It also `setSender`-s the wsClient's
  `send` so `appStore.submitAction` can call it.
- **Drop vs queue**: actions submitted while `connection.status !==
  "open"` are dropped with a `console.warn`. We don't queue because the
  server is authoritative and a stale action replayed across a
  reconnect would race with whatever state the server already shipped.
- **Auth token**: stubbed as `""` until the server lands a real session
  endpoint. The wsClient still passes the field; the server is free to
  ignore it for now.
- **WS URL**: `import.meta.env.VITE_WS_URL` if set, otherwise
  `${ws|wss}://${location.host}/ws`.

## Focus manager lifecycle

Each screen owns its own `FocusManager` and follows a strict
mount/dispose pattern: the manager is `attach()`-ed in the constructor,
focusable nodes are `register()`-ed there too, and `dispose()` calls
`detach()` + `clear()` before the router calls `Container.destroy`.

The alternative considered was a single window-attached manager swapped
between screens. Per-screen managers were chosen because each screen
already carries its own focus list, and `mountTextInputOverlay` - which
suspends the manager while the HTML overlay is focused - is then
trivially scoped to whichever screen mounted the overlay.

## Public API

This is an app, not a library. Entry point: `src/main.ts`.

## Invariants

- No HTML UI components (no React, no Tailwind). Everything visible
  renders through Pixi. Text input uses `mountTextInputOverlay` from
  `@durak/ui`.
- All keyboard nav goes through the per-screen `FocusManager`.
- Game state changes never come from local logic - always from server
  messages. The store's `submitAction` is the only path; it forwards
  through the active wsClient sender or drops with a warn when the
  socket is not `open`.
- `appStore` is a `zustand/vanilla` store. Pixi screens subscribe via
  `appStore.subscribe()`; there is no React in the bundle.

## Gotchas

- `mountTextInputOverlay` lives on `document.body` in DOM coordinates.
  The canvas is pinned to `inset: 0`, so Pixi screen-space coordinates
  match DOM coordinates 1:1 (CSS pixels). `LobbyScreen` re-mounts the
  overlay on every `layout()` so the `<input>` follows the panel on
  resize; the typed value is preserved across re-mounts.
- Placeholder room codes use `Math.random`. The no-`Math.random` rule
  applies to `packages/engine` only, not the client.

## Related ADRs

- ADR-0004: pure PixiJS client, no React
- ADR-0005: authoritative server with redacted snapshots and events
