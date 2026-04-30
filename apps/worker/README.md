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
  the DO records the disconnected seat, schedules a forfeit deadline
  30s out, and broadcasts `RoomState` with the disconnect populated to
  the surviving seat. A reconnect with the same seat token before the
  deadline cancels it and replays the current `Snapshot` so the
  rejoiner lands directly back in the game. On deadline fire the DO
  synthesizes a `GameOverState` declaring the absent seat the durak
  and emits a `GAME_OVER` event - the engine package is untouched.
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
- **Persistence** - `mode`, `seats`, `engine`, and `botSeat` are
  stored under a single `room` key in `state.storage` after every
  change. The constructor reloads them via `blockConcurrencyWhile`.
- **Worker fetch handler** (`src/index.ts`) - routes
  `POST /rooms`, `GET /ws/:roomId`, `OPTIONS /rooms`, `GET /health`,
  with origin allowlist and per-IP create-room rate limit.

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

- `POST /rooms` (JSON body `{ "mode": "human" | "bot" }`) →
  `{ roomId, hostToken, joinToken? }` per
  `packages/protocol/src/http.ts`.
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
- `.github/workflows/ci.yml` - the `deploy-worker` job runs on push
  to `main` after `check` passes:
  `pnpm --filter @durak/worker exec wrangler deploy` (no `--env`).

### Env / variables

- `ALLOWED_ORIGINS` (runtime, `[vars]` in `wrangler.toml`) -
  comma-separated origin allowlist for `POST /rooms` and ws
  upgrades. Default: `https://durak-icfred.web.app`. For `wrangler
  dev` on localhost, override to empty in `apps/worker/.dev.vars`
  (gitignored) so any origin is accepted.
- `TURN_TIMEOUT_MS` (runtime, default 30000) - per-turn deadline; the
  DO sets an Alarm for this many ms after each action.
- `DISCONNECT_FORFEIT_MS` (runtime, default 30000) - grace window
  between mid-round `webSocketClose` and forfeit. Same-token
  reconnect inside the window cancels the forfeit. Tests override
  this and use a test-only alarm fire seam.
- `CLOUDFLARE_API_TOKEN` (CI secret) - Workers + DO scopes.
- `CLOUDFLARE_ACCOUNT_ID` (CI secret) - account id for the deploy.

### First-time provisioning

```
wrangler login
wrangler whoami
# Confirm Workers Paid plan is active on the account; DOs require it.
pnpm --filter @durak/worker exec wrangler deploy
```

Generate a CI API token in the Cloudflare dashboard
(My Profile → API Tokens → "Edit Cloudflare Workers" template) and
set both `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as GitHub
repo secrets.

After that, every push to `main` redeploys via the `deploy-worker`
job.

### Rollback

Cloudflare keeps every deployment. To roll back:

```
wrangler rollback --message "DUR-NN: revert"
```

Or revert the offending commit on `main`; the next CI run redeploys
the prior code.

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
