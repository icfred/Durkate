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
  drives `appStore.connection`; `submitAction` and `requestRematch`
  flow through the controller-registered sender.
- **Phase auto-transition**: the connection handlers double as a phase
  driver. The first inbound `Snapshot` while in `lobby` advances the
  store to `game`; a `GAME_OVER` event in any inbound `Events` batch
  advances `game` to `gameover` and stamps `gameover` with `youSeat`
  (from the snapshot) and `durak`. A `closed` status while in `game`
  reverts to `lobby` so the lobby UX can show the "waiting for
  opponent" state until reconnect; `gameover` is sticky and never
  reverts.

## Sandbox

- `?sandbox=game` boots straight into `GameScreen` against a hand-rolled
  fixture `Snapshot`, bypassing the lobby. Pick a fixture with
  `?sandbox=game&fixture=<name>`; valid names are `fresh`, `midround`,
  `takepile`, `gameover`. Defaults to `fresh`.
- `?sandbox=gameover&fixture=won|lost|draw` boots straight into
  `GameOverScreen` with a fixture from `src/fixtures/gameOverFixtures.ts`.
  Lets a reviewer eyeball each outcome without playing a full round.
- `?sandbox=skins` boots the cosmetic skin spike sandbox.

Sandbox actions go to `submitAction` / `requestRematch` which drop with
a warn while the connection is not open.

## Boot flow

`src/main.ts`:

1. Loads JetBrains Mono and waits for the regular and bold weights.
2. Creates the Pixi `Application` against `#app`.
3. Parses `window.location.search` for a `?sandbox=…` fixture and
   `window.location.hash` for `#room=…`. If present, transitions the
   store to the matching phase before the router starts.
4. Builds the `ScreenRouter` with a factory keyed on `state.phase`:
   - `menu` -> `MainMenuScreen`
   - `lobby` -> `LobbyScreen`
   - `game` -> `GameScreen` (renders `appStore.snapshot`)
   - `gameover` -> `GameOverScreen` with `state.gameover` data and
     rematch / main-menu callbacks.
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
  `send` so `appStore.submitAction` and `appStore.requestRematch` can
  call it. Inbound handlers also drive the phase machine (snapshot
  -> game, GAME_OVER -> gameover, close-from-game -> lobby) and
  populate `appStore.room` from `RoomState` so the lobby can render
  "waiting for opponent" vs "starting" states.
- **Drop vs queue**: `submitAction` and `requestRematch` calls made
  while `connection.status !== "open"` are dropped with a `console.warn`.
  We don't queue because the server is authoritative and a stale
  action replayed across a reconnect would race with whatever state
  the server already shipped.
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
  messages. The store's `submitAction` and `requestRematch` are the
  only outbound paths; both forward through the active wsClient sender
  or drop with a warn when the socket is not `open`.
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

## Audio

Code-synthesized SFX only - no external assets. `src/audio/sfx.ts` defines
six clips (`playCard`, `takePile`, `win`, `lose`, `buttonHover`,
`buttonClick`) as short oscillator + envelope routines.
`src/audio/index.ts` exposes the runtime API.

- **Lazy context.** `playSfx(name)` lazily creates a single `AudioContext`
  on first call. `installAudioGestureUnlock()` wires a one-shot
  `pointerdown`/`keydown` listener at boot to satisfy browser autoplay
  policy. If the browser exposes no `AudioContext` (e.g. node-based test
  env), `playSfx` silently returns `false`.
- **Mute slice on the store.** `appStore.audio.muted` is the source of
  truth. `toggleMute()` and `setMuted()` flip it and persist to
  `localStorage` under `durak.audio.muted`. The store hydrates from
  `localStorage` on init so refresh remembers the choice.
- **Keyboard shortcut.** `bindMuteShortcut()` listens for `M` on `window`
  and skips when the active target is an `<input>` or `<textarea>` so it
  does not fire while a `TextInputOverlay` has focus.
- **Wiring buttons.** `withClickSound(handler)` wraps a `Button`'s
  `onActivate` with a click sound; `attachButtonHover(button)` adds the
  hover sound on `pointerover`. Use both at every `Button` construction
  site.
- **Game events.** `GameScreen` subscribes to the `appStore.events` ring
  buffer (via a `subscribeEvents` callback wired in `main.ts`) and plays
  `playCard` on `CARD_PLAYED`, `takePile` on `PILE_TAKEN`, and
  `win`/`lose` on `GAME_OVER` (decided against you / by you; a draw is
  silent). The wiring uses `appStore.eventsTotal` to deliver only newly
  appended events, so each event fires sfx exactly once even though
  `appendEvents` may run many times in a tick.

## Deployment

Hosted on [Cloudflare Pages](https://pages.cloudflare.com) as project
`durak-web`. See `docs/decisions/0007-hosting.md` for why.

### Pieces

- `apps/web/public/_redirects` - SPA fallback so any path serves
  `index.html` (room codes use hash routing, but this guards against
  future path routes too).
- `apps/web/public/_headers` - long cache for hashed `/assets/*`, basic
  security headers everywhere else.
- `.github/workflows/ci.yml` - the `deploy-web` job runs on push to
  `main` after `check` passes. It builds with `VITE_WS_URL` baked in,
  then `wrangler pages deploy apps/web/dist`.

### Env / variables

- `VITE_WS_URL` (build-time) - the wss URL of the deployed server.
  Stored as a **GitHub repo variable** (`vars.WEB_WS_URL`), not a
  secret, because it ends up in the public JS bundle. Example:
  `wss://durak-server.fly.dev`. If unset, `main.ts` falls back to
  `${ws|wss}://${location.host}/ws` (matches dev when the server is
  reverse-proxied).
- GitHub repo secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
  (used by the CI deploy job).

### First-time provisioning

```
wrangler login
wrangler pages project create durak-web --production-branch main
```

Set `WEB_WS_URL` as a repo variable in GitHub
(Settings → Secrets and variables → Actions → Variables).

After that, every push to `main` redeploys via the GitHub Actions
`deploy-web` job.

### Rollback

Cloudflare Pages keeps every deployment. To roll back:

1. Open the Pages project in the Cloudflare dashboard.
2. Find a known-good deployment in the history.
3. Click "Rollback to this deployment".

Equivalent CLI: `wrangler pages deployment list --project-name durak-web`
to find an ID, then redeploy via the dashboard. (The CLI does not
expose a one-shot rollback verb at the time of writing.)

## Related ADRs

- ADR-0004: pure PixiJS client, no React
- ADR-0005: authoritative server with redacted snapshots and events
- ADR-0007: public hosting on Fly.io and Cloudflare Pages
