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
- **ScreenRouter**: subscribes to `appStore` and rebuilds the active
  screen on relevant state change. Phase changes animate via the
  `src/anim/` engine (see "Boot flow" → transition matrix); same-phase
  swaps and the first mount swap instantly. The router only calls
  `dispose()` + `destroy()` on the old screen once the transition has
  completed.
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

## FFA mode (3-6 player free-for-all)

The MVP started as 1v1, then opened up to 3-6 player FFA once the engine
(ADR-0010) and worker (DUR-52) supported it. The web side renders all of it:

- **Main menu**: three entry points - PLAY VS BOT (1v1 vs medium bot), PLAY VS
  FRIEND (1v1 friend share), PLAY FFA (configurator). The FFA configurator is a
  third sub-view next to BOT-DIFFICULTY; rows cycle on Enter through PLAYERS
  (2..6), BOTS (0..playerCount-1, re-clamped if you cycle players down), and
  DIFFICULTY (easy/medium/hard - hidden from the wire when `botCount === 0`).
  Backspace returns to root via the shared `attachBackNav` helper.
- **Lobby**: shows `X / Y JOINED` (Y = `playerCount - botCount`) and renders
  one COPY LINK button per join token in `appStore.joinTokens` - the host hands
  out a different URL per remaining seat. Solo-vs-bots rooms hide the share
  section entirely. Each share URL is `#room=<id>&t=<token>&pc=<N>&bc=<M>` so
  the joiner's lobby renders the right "X / Y joined" before the first
  `RoomState`.
- **GameScreen radial layout** (per N seats):
  - N=2: opponent at top, self at bottom (current).
  - N=3: opponents at top-right and top-left.
  - N=4: opponents at right, top, left.
  - N=5: opponents at bottom-right, top-right, top-left, bottom-left.
  - N=6: five opponents evenly spaced around the upper half.
  Each opponent slot renders a face-down card stack with `× N` count badge,
  seat name (defaults to `Player {n+1}`), turn highlight, `thinking…` pulse
  when the seat appears in `appStore.room.thinkingSeats`, per-seat disconnect
  hint, and an "OUT" overlay when the seat is in `appStore.room.eliminated`.
- **Spectator mode**: when `snapshot.you.hand.length === 0` while the round is
  still running, the bottom hand row is replaced with the
  `YOU'RE OUT — SPECTATING` banner and `T` / `E` / card-pick are gated
  client-side. The mute toggle still works. On `GAME_OVER` the rematch flow is
  unchanged.
- **Share URL parsing**: `parseHashJoin` supports both single-token URLs
  (`#room=ABCD&t=tok`) and multi-token URLs (`#room=ABCD&t=tok1,tok2,tok3`).
  Optional `&pc=N&bc=M` carries the room shape so the joiner can render the
  right "X / Y joined" before the first `RoomState`. The joiner consumes the
  first token; if the worker rejects it the user sees the standard error
  toast.
- **Sandbox**: `?sandbox=game&fixture=ffa-3` (and `ffa-4`, `ffa-5`, `ffa-6`)
  renders the GameScreen against a hand-rolled mid-round snapshot to eyeball
  every layout slot.

## HUD

`GameScreen` overlays the table with a turn-state HUD so the player always
knows whose turn it is, what's legal, and which keys do what.

- **Turn label** (above the table). Reads `Your turn — attack`, `Your
  turn — defend`, or `Your turn — throw in or pass` when the local seat
  is active, otherwise `Opponent's turn`. Pulses on the player's turn
  via the shared Pixi `Ticker` (alpha wobble, ~1.2s period).
- **Legal-play tint** on hand cards. `legalPlay(snapshot, card)` is run
  per card on every snapshot. Legal cards stay full opacity with an
  accent-color outline; illegal cards drop to ~0.45 alpha with no
  outline. The defender check uses the engine `beats` helper, so cards
  that cannot legally beat the open attack are blocked client-side
  before the action ever leaves the client.
- **Key-hint strip** (above the hand row). Single line of hints derived
  from the current snapshot - lists only the keys that do something
  right now (`Enter`, `T`, `E`, `M`, arrow keys). Hidden while the
  snapshot is null.
- **Error toast** (above the key-hint strip). Surfaces server-rejected
  actions. `connection.ts onError` writes `{code, message}` into
  `appStore.lastError`; `GameScreen` shows the banner for ~3s and then
  calls `clearError()`. The previous behavior was a silent
  `console.error`, which is why illegal client-side actions felt like
  the game was frozen.
- **Bot thinking indicator**. When `appStore.room.thinkingSeats` includes
  the opponent seat (vs-bot mode while the worker's pre-move delay is
  pending), `GameScreen` renders a small "thinking…" label below the
  opponent hand row. The label opacity-pulses on the shared Pixi `Ticker`
  and scales with `appStore.devtools.animSpeed` (animSpeed === 0 holds it
  at full opacity rather than animating).
- **Card movement animations**. `GameScreen` subscribes to
  `appStore.events` and animates every card transition through the shared
  anim engine: attacks/defends slide from the player's hand to their
  table slot with `easeOutBack` and a brief fade-in; pile-takes and
  round-ends fly ghost copies of the leaving table cards to the taking
  hand or discard stack and fade out; talon draws and the initial deal
  fan cards out of the talon stack into seats with a per-card duration
  ramp. A snapshot update cancels any in-flight animation so the static
  layout always wins. All durations scale by `devtools.animSpeed`;
  `animSpeed === 0` skips animations entirely.

## Sandbox

- `?sandbox=game` boots straight into `GameScreen` against a hand-rolled
  fixture `Snapshot`, bypassing the lobby. Pick a fixture with
  `?sandbox=game&fixture=<name>`; valid names are `fresh`, `midround`,
  `takepile`, `trumpdrawn`, `gameover`, `ffa-3`, `ffa-4`, `ffa-5`, `ffa-6`.
  Defaults to `fresh`.
- `?sandbox=gameover&fixture=won|lost|draw` boots straight into
  `GameOverScreen` with a fixture from `src/fixtures/gameOverFixtures.ts`.
  Lets a reviewer eyeball each outcome without playing a full round.
- `?sandbox=skins` boots the cosmetic skin spike sandbox.
- `?sandbox=anims` boots the animation primitives sandbox - a grid of
  auto-looping cells, one per easing, plus `fadeTo`, `scaleTo`,
  `sequence`, and `parallel` demos.
- `?sandbox=sfx` boots a grid of every named SFX clip. Each button is
  hover-and-click playable so the crusher palette can be auditioned end
  to end without staging a real game.

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

### Transition matrix

Phase changes route through `src/transitions.ts`. Each transition runs
on the Pixi `Ticker` via the `src/anim/` engine; the old screen is only
disposed after the tween completes.

| From → To           | Animation                                          |
|---------------------|----------------------------------------------------|
| `menu → lobby`      | Lobby slides up from below; menu slides up off.    |
| `lobby → menu`      | Inverse: menu drops in from above; lobby drops off.|
| `lobby → game`      | Cross-fade.                                        |
| `game → lobby`      | Cross-fade.                                        |
| `game → gameover`   | Gameover panel slides down from top.               |
| `gameover → game`   | Cross-fade (rematch path).                         |
| `gameover → menu`   | Menu fades in over a darkening overlay.            |
| `menu → gameover`   | Inverse: menu fades out under a darkening overlay. |
| any other pair      | Default cross-fade.                                |

Durations multiply by `appStore.devtools.animSpeed` (the dev panel
slider). `animSpeed === 0` skips the tween entirely and disposes the
old screen immediately. The first mount (`prevPhase === null`) and any
key change inside a single phase (e.g. `lobby → lobby` with a different
room code) also skip animation.

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
  room), menu/gameover closes. It only opens once `currentToken` is set
  on the store, so the create-room POST resolves before the ws upgrade
  is attempted. The controller also `setSender`-s the wsClient's `send`
  so `appStore.submitAction` and `appStore.requestRematch` can call it.
  Inbound handlers also drive the phase machine (snapshot -> game,
  GAME_OVER -> gameover, close-from-game -> lobby) and populate
  `appStore.room` from `RoomState` so the lobby can render "waiting for
  opponent" vs "starting" states.
- `src/net/rooms.ts` issues `POST /rooms { mode }` to the server and
  returns `{ roomId, hostToken, joinToken? }`. The lobby flow drives
  this: clicking "Play vs bot" or "Play vs friend" calls
  `beginRoomCreation(mode)` (lobby renders "CREATING ROOM..."), then
  on success `roomCreated()` populates the store with the real room id
  and seat token; on failure `roomCreationFailed()` shows an inline
  error with a retry button. A user opening the share URL skips the
  POST and enters the lobby via `enterLobbyAsJoiner` with the embedded
  token.
- **Drop vs queue**: `submitAction` and `requestRematch` calls made
  while `connection.status !== "open"` are dropped with a `console.warn`.
  We don't queue because the server is authoritative and a stale
  action replayed across a reconnect would race with whatever state
  the server already shipped.
- **Auth token**: per-room seat token issued by `POST /rooms`. The host
  receives `hostToken` (seat 0). For human-vs-human rooms a `joinToken`
  is returned to the host and embedded in the share URL hash as
  `#room=<id>&t=<joinToken>`; the joiner's client extracts the token
  and uses it on the ws upgrade.
- **WS URL**: `import.meta.env.VITE_WS_URL` if set, otherwise
  `${ws|wss}://${location.host}/ws`.
- **HTTP server URL**: used for `POST /rooms`. Defaults to the same
  origin as the ws URL (with `ws[s]://` rewritten to `http[s]://` and
  the `/ws` path stripped). Override with `VITE_SERVER_URL`.

## Local dev

`pnpm dev` from the repo root runs the worker (`wrangler dev` on port
8787) and the web (Vite on port 5173) in parallel. The Vite config
(`vite.config.ts`) proxies `/rooms`, `/ws`, and `/health` from `:5173`
to `:8787`, so the client just talks to its own origin and no
`VITE_WS_URL` / `VITE_SERVER_URL` env override is needed in dev. To
proxy to a different server (e.g. a remote dev box), set
`VITE_DEV_PROXY_TARGET=http://other.host:8787`.

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
the clip palette as short oscillator + envelope routines.
`src/audio/index.ts` exposes the runtime API. Aesthetic target is the
Papers Please feel: pixelated, downsampled, slightly noisy.

- **Crusher.** `src/audio/crusher.ts` wires every clip through a shared
  chain before the master gain: low-pass `BiquadFilter` (~6 kHz) →
  `WaveShaper` soft drive → `ScriptProcessorNode` doing bit-crush
  (default 8 bits) and sample-rate reduction (sample-and-hold every 4
  frames) → output gain. A continuous low-level `BufferSource` of white
  noise is mixed in for tape-grit. Each stage degrades gracefully when
  the runtime omits the underlying API (the test env keeps the chain
  intact).
- **Clip palette** (all routed through the crusher):
  - Gameplay: `playCard`, `takePile`, `win`, `lose`, `dealStart`,
    `talonDraw`, `roundEnd`.
  - UI: `buttonHover`, `buttonClick`, `navMove`, `navConfirm`,
    `navBack`, `actionError`.
- **Lazy context.** `playSfx(name)` lazily creates a single `AudioContext`
  on first call and builds the crusher inline. `installAudioGestureUnlock()`
  wires a one-shot `pointerdown`/`keydown` listener at boot to satisfy
  browser autoplay policy. If the browser exposes no `AudioContext`
  (e.g. node-based test env), `playSfx` silently returns `false`.
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
- **Wiring focus.** `attachFocusNavSfx(focus)` subscribes to a screen's
  `FocusManager` and plays `navMove` whenever focus actually changes
  index (idempotent — a no-op when arrow keys hit the same node) and
  `navConfirm` on Enter / Space activation. Each screen owns the
  unsubscribe and calls it from `dispose()`.
- **Game events.** `GameScreen` subscribes to the `appStore.events` ring
  buffer (via a `subscribeEvents` callback wired in `main.ts`) and plays
  `playCard` on `CARD_PLAYED`, `takePile` on `PILE_TAKEN`, `dealStart`
  on `GAME_STARTED`, `talonDraw` on `TALON_DRAWN`, `roundEnd` on
  `ROUND_ENDED`, and `win`/`lose` on `GAME_OVER` (decided against you /
  by you; a draw is silent). It also fires `actionError` whenever a new
  `lastError` arrives in the store (server-rejected action). The wiring
  uses `appStore.eventsTotal` to deliver only newly appended events, so
  each event fires sfx exactly once even though `appendEvents` may run
  many times in a tick.
- **SFX sandbox.** `?sandbox=sfx` mounts a grid of buttons - one per
  named clip - with hover-to-preview and click-to-replay. Useful for
  auditioning the crusher palette without staging a full match.

## Animations

`src/anim/` is the shared tween engine. No external dependency; everything
runs on the Pixi `Ticker`.

- **`tween({ from, to, durationMs, easing, onUpdate, onComplete, ticker?, now?, speed? })`**
  -> `{ cancel }`. Numeric interpolation called once per frame. `now` is
  the time source - defaults to `performance.now`, swapped in tests for
  deterministic clocks. `speed` is an optional `() => number` factor;
  call sites pass `() => appStore.getState().devtools.animSpeed` to let
  the dev panel slider scale tween durations globally.
- **Easings** in `easings.ts`: `linear`, `easeOutQuad`, `easeInQuad`,
  `easeInOutCubic`, `easeOutBack`. Pure `(t) -> number` over `[0, 1]`,
  always returning `0` at `t=0` and `1` at `t=1` (back-overshoot
  excepted, by design).
- **`compose.ts`** wraps `Anim = (done) => TweenHandle` factories.
  `sequence(anims, onComplete?)` runs in order, each anim's `done`
  triggers the next. `parallel(anims, onComplete?)` starts all
  immediately and fires `onComplete` once every child has signalled
  done. Both return `{ cancel }` and propagate cancel to running
  children.
- **`pixi.ts`** sugar for the common cases: `fadeTo(target, alpha, ms,
  easing?, opts?)`, `moveTo(target, x, y, ms, easing?, opts?)`,
  `scaleTo(target, scale, ms, easing?, opts?)`. Each returns the
  underlying `TweenHandle`.
- **Sandbox.** `?sandbox=anims` mounts a grid auditioning every
  primitive. Cells loop forever; the screen's `dispose()` cancels them.

## Dev tools

`Ctrl+Shift+D` toggles a hidden Pixi overlay anchored to the top-right of
the canvas. It is invisible by default and never shipped behind a UI
affordance. The panel state lives on `appStore.devtools` and persists
across reloads via `localStorage` under `durak.devtools`.

The panel renders:

- **Connection status** — `connection.status`, attempt count, last error.
- **Phase** — current `appStore.phase`.
- **Snapshot JSON** — pretty-printed `appStore.snapshot`. Read-only.
  Arrow keys scroll while the panel is open.
- **Events ring** — last 16 entries from `appStore.events`.

Toggles, all clickable inside the panel:

- **Autoplay** — when on, every snapshot in which the local seat is the
  active actor is fed through `bot.choose` and the resulting `Action` is
  submitted via `appStore.submitAction`. Same snapshot never fires twice.
  Used as the test harness for bot-difficulty work: a bot vs bot game
  runs to `GAME_OVER` with no input.
- **Animation speed** — slider `[0, 2]`, default `1.0x`. Stored as
  `devtools.animSpeed`. The animation engine is expected to read this
  value and scale tween durations accordingly. The contract is one-way:
  the dev panel writes, the renderer reads.
- **Mute** — mirrors `audio.muted`.
- **Disconnect ws** — calls `connection.forceDisconnect()`, useful for
  testing disconnect-forfeit behaviour.

`Escape` closes the panel; `Ctrl+Shift+D` always toggles regardless of
focus.

## Deployment

Hosted on Cloudflare Pages (`durak-web` project), custom domain
`durak.icfred.co.uk`. See `docs/decisions/0007-hosting.md` for the
historical context (Firebase Hosting was used initially and retired
in favour of Pages — see the ADR addendum).

### One command

```
pnpm --filter @durak/web run deploy
```

That script bakes `VITE_WS_URL=wss://durak-server.icfred.workers.dev/ws`
into the build and runs `wrangler pages deploy dist
--project-name=durak-web --branch=main`.

### Env / variables

- `VITE_WS_URL` (build-time) - the wss URL of the deployed worker,
  including the `/ws` path. `wsClient.buildSocketUrl` appends
  `/<roomId>`; `httpFromWsUrl` drops the path for `POST /rooms`, so the
  same env serves both routes. If unset, `main.ts` falls back to
  `${ws|wss}://${location.host}/ws` (matches dev when the worker is
  reverse-proxied). The trailing `/ws` is non-negotiable — without it
  the websocket lands at `/<roomId>` and the worker rejects it.
- The `pnpm deploy` script hard-codes the prod value; override only for
  one-offs by exporting `VITE_WS_URL` and running `pnpm build && wrangler
  pages deploy dist --project-name=durak-web` manually.

### First-time provisioning

```
wrangler login
wrangler pages project create durak-web --production-branch=main
pnpm --filter @durak/web run deploy
```

Then attach `durak.icfred.co.uk` as a custom domain in the Cloudflare
dashboard (Pages project → Custom domains). The `icfred.co.uk` zone is
not on this Cloudflare account, so the dashboard issues a CNAME target
to point at from external DNS.

### Rollback

Pages keeps every deployment. To roll back, either redeploy a prior
git ref:

```
git checkout <good-sha>
pnpm --filter @durak/web run deploy
```

Or use the Cloudflare dashboard (Pages project → Deployments → ⋯ →
Rollback to this deployment).

## Related ADRs

- ADR-0004: pure PixiJS client, no React
- ADR-0005: authoritative server with redacted snapshots and events
- ADR-0007: hosting on Cloudflare Workers + Durable Objects (static
  client originally on Firebase Hosting, retired for Cloudflare Pages
  per the addendum)
