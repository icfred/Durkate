# @durak/worker

## Purpose

Cloudflare Worker + Durable Object that hosts the Durak game server.
One Durable Object per match, holding the engine state, bot driver,
turn timer, rate-limit bucket, and per-seat client list. The worker
fetch handler is a thin shell around it: `POST /rooms` allocates a
fresh DO, `GET /ws/:roomId?token=…` upgrades a websocket and forwards
to the DO, `GET /health` returns 200.

See `docs/decisions/0007-hosting.md` for the choice of platform, and
ADR-0005 for the authoritative-server protocol shape this worker
implements.

## Key concepts

- **`Room` Durable Object** (`src/room.ts`) - one instance per match,
  named by the public room id. Holds engine state, bot driver, the
  per-WS rate-limit buckets, and the persisted seat/token map.
- **WebSocket Hibernation API** - `state.acceptWebSocket(ws)` lets the
  DO sleep between messages without dropping connected clients. Per-WS
  state (the seat) lives in `ws.serializeAttachment`.
- **DO Alarms (`src/alarms.ts`)** - one platform alarm slot, multiple
  logical deadlines. `AlarmScheduler` keeps a `Map<DeadlineKind,
  forfeitAt>` and arms the platform alarm at the earliest. Used today
  for the per-turn timeout and the disconnect forfeit; future
  deadlines (room GC, rematch) compose the same way. Survives
  hibernation and DO eviction because the map is serialized into the
  persisted room blob.
- **Disconnect forfeit (ADR-0009)** - on `webSocketClose` mid-round,
  the DO appends a `DisconnectState { seat, forfeitAt }` to the room's
  `disconnects[]` array (multiple seats can be in countdown
  simultaneously), arms the `forfeit` alarm at the earliest deadline,
  and broadcasts `RoomState` with the disconnect populated to the
  surviving seats. A reconnect with the same seat token before the
  deadline cancels it and replays the current `Snapshot` so the
  rejoiner lands directly back in the game. On deadline fire the DO
  synthesizes a `GameOverState` declaring the earliest-deadline absent
  seat the durak and emits a `GAME_OVER` event - the engine package is
  untouched. At N>2, this means a forfeit ends the round; full
  forfeit-as-elimination (game continues with remaining players) would
  need engine cooperation to skip a mid-round seat without legal cards
  and is intentionally out of scope.
- **Room GC** - three eviction triggers, all routed through the same
  `AlarmScheduler` slot:
  - `abandoned` (5 min) - room created via `POST /rooms` but no client
    ever attached; first ws upgrade cancels it.
  - `idle` (5 min) - all clients have closed and the game isn't yet
    over; a reconnect cancels it.
  - `stale` (10 min) - game-over has lingered without rematch; any
    rematch firing cancels it.
  Eviction = `state.storage.deleteAll()` plus an in-memory clear, then
  the DO can be hibernated freely. Logged via `console.info` on each
  eviction so prod logs show the GC rhythm.
- **Persistence** - `playerCount`, `seats`, `engine`, `botSeats`,
  `rematchSeats`, `disconnects`, and the alarm `deadlines` map are
  stored under a single `room` key in `state.storage` after every
  change. The constructor reloads them via `blockConcurrencyWhile` and
  translates legacy 2-player blobs (`mode` + `botSeat` shape) on the
  fly so in-flight upgrades don't lose state.
- **N-player rooms (DUR-52)** - rooms carry a `playerCount` of 2..6
  set at creation. `botSeats: SeatIndex[]` lists every bot seat (zero
  or more). Seats fill from index 0; bots reserve the highest seat
  indices first so the host always lands on seat 0.
- **Spectator semantics** - eliminated seats (PLAYER_OUT fired by the
  engine) stay attached to the room and keep receiving `Snapshot`,
  `Events`, and `RoomState` broadcasts. `applyAction` from an
  eliminated seat returns `Error { code: "FORBIDDEN_ACTION" }` and the
  ws is *not* closed. `RoomStateMessage.eliminated` carries the
  current set so clients can render the spectator view. A small
  helper, `advancePastEliminatedActor`, synthesizes a `TIMEOUT` for
  any eliminated seat that is still listed as the engine's
  `attacker`/`defender` mid-round so the round resolves through the
  engine's `rotateRoles` path (which already skips eliminated seats).
- **Worker fetch handler** (`src/index.ts`) - routes
  `POST /rooms`, `GET /ws/:roomId`, `OPTIONS /rooms`, `GET /health`,
  with origin allowlist and per-IP create-room rate limit.

## FFA throw-in window (ADR-0011)

When the engine accepts an `END_ROUND` or `TAKE_PILE` while
`playerCount > 2`, the worker defers the apply by `CLOSE_WINDOW_MS`
(default 2.5 s). The pending state lives on the room as
`pendingClose: { kind, closesAt, passed[] } | null` and rides every
`RoomState` broadcast so clients can render the countdown.

- `THROW_IN` during the window applies through the engine and resets
  `closesAt` to `now + CLOSE_WINDOW_MS`; `passed[]` is cleared.
- `PASS { by }` (engine-level, pure observer) appends to `passed[]`.
  When every non-eliminated non-defender has passed, the close fires
  immediately.
- Other actions (including a duplicate `END_ROUND` / `TAKE_PILE`) are
  rejected with `FORBIDDEN_ACTION`.
- The `close-window` alarm fires the deferred action if no one has
  thrown in or passed the threshold.
- N=2 collapses the window to zero (the only non-defender is the
  attacker, who already had unbounded time pre-submit).
- Bot fan-out: every non-defender non-eliminated bot is queued on
  `botFanOut: Map<seat, deadline>`; when the shared `bot-think` alarm
  fires it drains the map. Each bot picks the cheapest matching-rank
  `THROW_IN` if any, else `PASS`.
- Tunable env var: `CLOSE_WINDOW_MS`. The vitest config sets it to `0`
  by default so existing end-to-end flows aren't slowed; window-aware
  tests opt in via `testSetCloseWindowMs(...)`.

## Bot pacing

Bots don't snap moves the instant it's their turn. Every transition that
hands the active seat to a bot schedules a `bot-think` deadline via the
`AlarmScheduler`; firing the alarm runs one bot move and, if the active
seat is still a bot, schedules the next deadline. The driver replaces the
old synchronous `runBotTurns()` loop with an alarm chain bounded by the
existing `botIterationCap` so a misbehaving heuristic still can't spin
forever. The driver is N-bot from DUR-52: the engine returns a single
active actor at any time, so multi-bot rooms simply produce more
iterations of the same alarm chain — no parallelism.

- Delay model lives in `src/bot-pacing.ts`. Default bounds: 400-1400 ms,
  scaled per difficulty (easy 0.7, medium 1.0, hard 1.2). The bound is
  blended from a complexity factor (count of legal actions for the bot at
  the current state — more options "thinks longer") and a single jitter
  draw from a *clone* of `state.rng`. Cloning preserves engine purity per
  ADR-0003: the bot remains a pure observer of `state.rng`.
- Determinism: same seed + same action sequence -> same think-delay
  sequence. The pure unit tests in `bot-pacing.test.ts` enforce both the
  bounds property and the no-mutation contract.
- All-bots autoplay (DUR-52): when every non-eliminated seat is a bot
  (typical case: humans got eliminated and now spectate), the bot-think
  delay is multiplied by 0.5 so the round wraps up quickly. Spectator
  humans still receive snapshots + events at full fidelity; only the
  bot pacing speeds up.
- Tunable via env: `BOT_THINK_MIN_MS`, `BOT_THINK_MAX_MS`. Setting both to
  `0` disables pacing — the room falls back to the synchronous fast path
  for tests and dev.
- Protocol surface: `RoomStateMessage.thinkingSeats?: SeatIndex[]` lists
  any bot seats currently in their pre-move delay. The worker populates
  this whenever a `bot-think` alarm is pending and clears it on fire.

## Rematch

When the engine reaches `phase: "game-over"`, clients can request a
fresh round with `RequestRematch`. The DO tracks per-seat opt-in
flags (`rematchSeats[]`) alongside the engine state and seat tokens.

- Bot mode: rematch fires the moment the human's `RequestRematch`
  arrives — no second seat to wait for.
- Human mode: rematch fires only when both seats have opted in.
  While only one seat has requested, the DO broadcasts a fresh
  `RoomState` whose `rematchRequested: SeatIndex[]` carries the
  pending set so the other client can render a "WAITING FOR
  OPPONENT" hint. Pending state is the only signal — no separate
  server message variant is introduced.
- On fire: the DO picks a fresh seed via `crypto.getRandomValues`,
  re-runs `initialState({ seed }) -> step({ type: "START_GAME" })`,
  resets `rematchSeats[]`, and broadcasts a new `Snapshot` plus
  `Events` (which include `GAME_STARTED`). Tokens are unchanged —
  the same connected clients are used. The bot driver is re-armed
  via the existing `runBotTurns` path.
- A `RequestRematch` outside of `phase: "game-over"` returns an
  `Error { code: "REMATCH_NOT_AVAILABLE" }` and otherwise leaves
  state untouched.

## Public API

This is an app, not a library. The wire surface is:

- `POST /rooms` accepts either shape:
  - **N-player (canonical)**:
    `{ playerCount: 2|3|4|5|6, botCount: 0..(playerCount-1), difficulty?: "easy"|"medium"|"hard" }`
  - **Legacy (back-compat for the existing 1v1 web client)**:
    `{ mode: "human" | "bot", difficulty? }` translates to
    `playerCount: 2, botCount: mode === "bot" ? 1 : 0`.

  Returns
  `{ roomId, hostToken, joinTokens: string[], joinToken? }`. The
  legacy `joinToken` is populated only when `joinTokens.length === 1`
  so the existing 2-player web flow keeps working until DUR-53.
- `GET /ws/:roomId?token=<seatToken>` → websocket upgrade. Inbound
  messages parsed via `parseClientMessage` (Zod). Outbound messages
  match `ServerMessage` (`Snapshot`, `Events`, `RoomState`, `Error`).
- `GET /health` → `{ ok: true }`.

## Invariants

- The engine, bot, redactor, and protocol packages are unchanged. The
  worker is a thin I/O shell.
- Tokens are 256-bit base64url strings (`crypto.getRandomValues`).
- Inbound websocket frames are Zod-parsed; malformed messages drop the
  connection.
- Per-WS rate limit (token bucket, capacity 20 / 5s) drops floods.
- Origin allowlist (`ALLOWED_ORIGINS` env var, comma-separated)
  applies to both the `POST /rooms` route and the ws upgrade.

## Local dev

```
pnpm --filter @durak/worker dev
```

Runs `wrangler dev` on port 8787 with miniflare emulating Workers +
Durable Objects locally. Pair it with `pnpm --filter @durak/web dev`
(or the root `pnpm dev` for both) — Vite proxies `/rooms`, `/ws`, and
`/health` to `:8787`.

## Tests

```
pnpm --filter @durak/worker test
```

Vitest under `@cloudflare/vitest-pool-workers` (Miniflare). Covers
worker fetch routes, ws upgrade error paths, the human-mode ws
roundtrip with both seats, and a full vs-bot game played end-to-end
through the public API.

`redact.test.ts` and `rate-limit.test.ts` are pure unit tests; the
property tests for `redactFor` (the security-critical seat-redaction
function) port over from the old Fastify server unchanged.

## Deployment

Hosted on Cloudflare Workers in the `icfred` account.
Worker name: `durak-server`. Public URL:
`https://durak-server.icfred.workers.dev`.

### Pieces

- `wrangler.toml` - single env (no `[env.*]` blocks). Wrangler env
  splits don't inherit `[[durable_objects.bindings]]` or
  `[[migrations]]` from the top level, and `--env <name>` appends
  `-<name>` to the worker name unless overridden — both bit the
  first prod deploy. Single config sidesteps both. Defaults are
  the production values; local dev overrides via `.dev.vars`.
- Deploy: `pnpm --filter @durak/worker run deploy` (runs `wrangler deploy`).
  Note the explicit `run` — `pnpm deploy` is a built-in command and clashes
  with the script name. No CI; the user runs this manually after pushing
  to `main`.

### Env / variables

- `ALLOWED_ORIGINS` (runtime, `[vars]` in `wrangler.toml`) -
  comma-separated origin allowlist for `POST /rooms` and ws
  upgrades. Production: `https://durak.icfred.co.uk`. For `wrangler
  dev` on localhost, override to empty in `apps/worker/.dev.vars`
  (gitignored) so any origin is accepted.
- `TURN_TIMEOUT_MS` (runtime, default 30000) - per-turn deadline; the
  DO sets an Alarm for this many ms after each action.
- `DISCONNECT_FORFEIT_MS` (runtime, default 30000) - grace window
  between mid-round `webSocketClose` and forfeit. Same-token
  reconnect inside the window cancels the forfeit. Tests override
  this and use a test-only alarm fire seam.
- `BOT_THINK_MIN_MS` / `BOT_THINK_MAX_MS` (runtime, defaults 400 / 1400) -
  bounds for the bot pre-move "thinking" delay. Both `0` disables pacing
  (bot acts synchronously). The vitest pool sets both to `0` so existing
  end-to-end bot games stay deterministic without advancing fake time.
- `CLOSE_WINDOW_MS` (runtime, default 2500) - FFA throw-in pacing window
  (ADR-0011). `0` disables the window entirely (round-resolving actions
  apply instantly). The vitest pool sets this to `0` for the same reason
  as bot pacing.
### First-time provisioning

```
wrangler login
wrangler whoami
# Confirm Workers Paid plan is active on the account; DOs require it.
pnpm --filter @durak/worker run deploy
```

### Rollback

Cloudflare keeps every deployment. To roll back:

```
pnpm --filter @durak/worker exec wrangler rollback --message "revert"
```

Or revert the offending commit on `main` and re-run
`pnpm --filter @durak/worker run deploy`.

## Gotchas

- **DO storage is durable.** A successful test can leave behind room
  state in miniflare's local storage between vitest runs. The test
  pool wipes per-test by default, but if you debug locally with
  `wrangler dev` and a real worker, run
  `wrangler durable-objects delete --class-name Room <id>` to reset.
- **Hibernation reconstructs the DO.** Anything in instance state
  that isn't persisted is lost across hibernation. The rate-limit
  buckets are intentionally in-memory only - the bucket refills
  during the quiet period anyway.
- **Worker isolates are short-lived.** The per-IP create-room rate
  limit is best-effort; an attacker that lands on a fresh isolate
  effectively gets a fresh bucket. For real DDoS protection, lean on
  Cloudflare's edge controls, not this in-memory bucket.
- **`new Request(forwarded)` preserves the `Upgrade: websocket`
  header.** Without it, the DO would not see the upgrade and would
  return 426.

## Related ADRs

- ADR-0003: determinism strategy (engine takes seed from the host)
- ADR-0005: authoritative server with redacted snapshots and events
- ADR-0007: hosting on Cloudflare Workers + Durable Objects and
  Firebase Hosting
- ADR-0009: disconnect forfeit policy (30s reconnect window, then
  the absent seat is declared the durak)
