# @durak/server

## Purpose

Authoritative game server. Fastify HTTP + WebSocket gateway. Owns all
game state, the seed for every game's RNG, turn timers, and per-player
redacted snapshots.

## Key concepts

- **Gateway**: the ws endpoint. Validates inbound messages with Zod,
  attributes them to a seat via session token, dispatches `SubmitAction`
  to the room.
- **Room**: a single live game. Holds the engine state, runs every
  inbound action through `step`, broadcasts per-seat redacted snapshots
  and events, manages the turn timer.
- **Redactor** (`src/redact.ts`): pure `redactFor(state, seat) ->
  Snapshot`. Strips opponent hand, talon contents, and RNG state. Most
  security-critical file in the project.
- **Seat**: a position at a room (one human or one bot). Owns a session
  token issued at join. In a bot room the bot's token is generated for
  shape parity but is never consumed (no ws connection).
- **Session token**: opaque string bound to a seat. Required on ws
  upgrade.
- **Token bucket** (`src/rate-limit.ts`): per-connection rate limit on
  inbound messages.

## Public API

This is an app, not a library. Entry point: `src/main.ts`.

Listens on `PORT` (default 3001), `HOST` (default 0.0.0.0).

Current routes:
- `GET /health` - liveness probe, returns `{ ok: true }`
- `POST /rooms` - create a new room. Body `{ mode: "human" | "bot" }`,
  validated by Zod. Returns 201 `{ roomId, hostToken, joinToken? }`:
  `hostToken` is bound to seat 0; `joinToken` (only present for
  `mode: "human"`) is bound to seat 1. CORS uses the same `allowedOrigins`
  allowlist as the ws gateway, with an `OPTIONS` preflight handler.
  Per-IP token-bucket rate limit (default 10 / 60s); over-budget POSTs
  return 429.
- `GET /ws/:roomId?token=...` - WebSocket upgrade. Looks up the room and
  resolves the seat from the token. Unknown room or forged token is
  rejected with a typed `Error` and the socket is closed. Inbound
  messages are Zod-parsed; parse failure sends `{ Error, BAD_MESSAGE }`
  and closes. `SubmitAction` is dispatched to the room and produces a
  per-seat `Snapshot` + `Events` broadcast on success, or a per-seat
  `Error` on rejection. `RequestRematch` returns `{ Error,
  NOT_IMPLEMENTED }`. On join/leave/disconnect the gateway broadcasts
  `RoomState`. Each connection has a token-bucket rate limit (default
  20 actions per 5 seconds); over-budget messages are dropped with a
  warn log.

Planned routes (not yet implemented):
- `GET /rooms/:id` - room metadata (lobby state)

## Room modes

A room is created in one of two modes (default `human`):

- `human`: two human seats, each with a session token, both must
  connect via ws before the game starts.
- `bot`: seat 1 is permanently reserved for the rule-based bot from
  `@durak/engine`. The bot has no ws and no token in use; the room
  treats it as always attached, so `maybeStartGame` fires as soon as
  the human at seat 0 connects. The human always sits at seat 0 in a
  bot room — this is a hard invariant the lobby relies on.

The mode is set at room creation (`registry.create({ mode: "bot" })`,
or `POST /rooms { mode: "bot" }` from a client) and is immutable for the
room's lifetime.

## Game loop

The room is the authoritative game-loop coordinator.

- **Start**: when both seats are filled and both clients are connected,
  the gateway calls `room.start(seed)`. The seed is derived from
  `crypto.randomInt`. The room runs `START_GAME` through `step`,
  broadcasts the initial `Snapshot` + `Events` (a `GAME_STARTED` event)
  to each seat, and arms the turn timer. Clients cannot send
  `START_GAME`; the room rejects it with `FORBIDDEN_ACTION`.
- **Action**: on `SubmitAction`, the room overrides `action.by` with
  the connection's bound seat (clients never set `by`). The action runs
  through `step`. On success the room replaces its state, broadcasts
  per-seat `Snapshot` + `Events` to every connected client, and re-arms
  the turn timer. On rejection the engine's reason is returned and the
  gateway sends a single `Error` to the offending seat.
- **Bot driver** (vs-bot rooms only): after every `step` that advances
  state, the room loops `bot.choose(state)` -> `step` while the active
  actor is the bot seat, broadcasting a `Snapshot` + `Events` pair to
  the human after each bot decision. The loop ends when the active
  actor is the human or the game is over. A defensive cap (200
  iterations by default) guards against runaway loops; tripping it
  emits a `BOT_LOOP_CAP` `Error` to the human and stops the driver.
  An illegal bot action (which the rule-based bot does not produce)
  emits `BOT_ILLEGAL_ACTION`. Bot timeouts ride the existing turn
  timer; there is no separate bot timer.
- **Turn timer**: `setTimeout` per turn, default 30 seconds, injectable.
  On expiry the room derives a synthetic action from the current state
  (`TAKE_PILE` if any pair on the table is undefended, otherwise
  `END_ROUND`) and dispatches it. Once the engine ships native
  `TIMEOUT` handling (DUR-9 follow-up), this synthesis collapses into a
  single action.
- **Snapshot redaction**: `redactFor(state, seat)` produces the per-seat
  `Snapshot`. It exposes only the requesting seat's hand, the table,
  the discard pile, the trump card, and the count of cards remaining in
  each hand and the talon. Opponent hand cards, talon contents, and the
  RNG state never appear. The redactor is enforced by both the
  protocol's structural type guards and property tests over random
  game traces.

## Invariants

- Every inbound ws message is parsed by Zod before any processing.
- Every action is run through the engine; rejected actions never affect
  state.
- The connection's bound seat overrides `action.by`; clients cannot
  forge a seat.
- Per-seat redacted snapshots: opponent hand contents, deck contents,
  and RNG state never appear in any outbound message.
- The seed for each room lives only on the server.
- Turn timers and bot delays are server-side only.

## Gotchas

- Bot delays for player comprehensibility are not yet wired; the bot
  driver fires bot actions synchronously after each human action. A
  presentation-layer setTimeout will be added when "bot is thinking"
  pacing matters for the UX.
- pino is the logger. Use `pino-pretty` in dev for readable output.
- The turn-timer synthesis is a stand-in for the engine's eventual
  native `TIMEOUT` action; revisit when DUR-9's talon-replenish and
  game-over rules land.

## Deployment

Hosted on [Fly.io](https://fly.io) as app `durak-server`. See
`docs/decisions/0007-hosting.md` for why.

### Pieces

- `apps/server/Dockerfile` - multi-stage build that bundles the server with
  esbuild into a single self-contained `dist-bundle/main.mjs` and ships it
  on a `node:22-bookworm-slim` runtime.
- `fly.toml` (repo root) - app config: region, memory, health check on
  `/health`, autostart/autostop.
- `.github/workflows/ci.yml` - the `deploy-server` job runs on push to
  `main` after `check` passes.

### Env / secrets

- `PORT` - injected by Fly (8080). The app honors `process.env.PORT`.
- `HOST` - `0.0.0.0` in container.
- `NODE_ENV=production` - set in the Dockerfile so pino skips the
  `pino-pretty` transport.
- `ALLOWED_ORIGINS` - CSV of origins permitted to upgrade the ws route.
  Empty means "any origin", which is the dev default. Set in production
  via `flyctl secrets set ALLOWED_ORIGINS=https://durak-web.pages.dev`.
- GitHub repo secret: `FLY_API_TOKEN` (used by the CI deploy job).

### First-time provisioning

```
flyctl auth login
flyctl launch --no-deploy --copy-config --name durak-server --region iad
flyctl secrets set ALLOWED_ORIGINS=https://durak-web.pages.dev
```

After that, every push to `main` redeploys via the GitHub Actions
`deploy-server` job.

### Logs

```
flyctl logs -a durak-server
```

### Rollback

```
flyctl releases -a durak-server                 # list releases
flyctl releases rollback <version> -a durak-server
```

This swaps the running Machine to the prior image without rebuilding.

## Related ADRs

- ADR-0003: determinism strategy
- ADR-0005: authoritative server with redacted snapshots and events
- ADR-0007: public hosting on Fly.io and Cloudflare Pages
