# @durak/server

## Purpose

Authoritative game server. Fastify HTTP + WebSocket gateway. Owns all
game state, the seed for every game's RNG, turn timers, and per-player
redacted snapshots.

## Key concepts

- **Gateway**: the ws endpoint. Validates inbound messages with Zod,
  attributes them to a seat via session token, routes to the room.
- **Room**: a single live game. Holds the engine state, manages timers,
  emits snapshots + events to its connected clients.
- **Seat**: a position at a room (one human or one bot). Owns a session
  token issued at join.
- **Session token**: opaque string bound to a seat. Required on ws
  upgrade.

## Public API

This is an app, not a library. Entry point: `src/main.ts`.

Listens on `PORT` (default 3001), `HOST` (default 0.0.0.0).

Current routes:
- `GET /health` - liveness probe, returns `{ ok: true }`
- `GET /ws/:roomId?token=...` - WebSocket upgrade. Looks up the room and
  resolves the seat from the token via `RoomRegistry`. Unknown room or
  forged token is rejected with a typed `Error` and the socket is
  closed. Inbound messages are Zod-parsed via
  `clientMessageSchema`; on parse failure the gateway sends an `Error`
  with code `BAD_MESSAGE` and closes. `SubmitAction` currently routes to
  a stub engine that returns a placeholder `Snapshot` so the wire path
  is exercised end-to-end. `RequestRematch` returns
  `{ Error, code: NOT_IMPLEMENTED }`. On join, leave, and disconnect the
  gateway broadcasts `RoomState` to every connected seat. Per-connection
  rate limiting lands with the engine wiring (DUR-18).

Planned routes (not yet implemented):
- `POST /rooms` - create a room, returns roomId + seat tokens
- `GET /rooms/:id` - room metadata (lobby state)

## Invariants

- Every inbound ws message is parsed by Zod before any processing.
- Every action is run through the engine; rejected actions never affect
  state.
- Per-player redacted snapshots: opponent hand contents, deck contents,
  and RNG state never appear in any outbound message.
- The seed for each room lives only on the server.
- Turn timers and bot delays are server-side only.

## Gotchas

- Bot delays for player comprehensibility live here, not in the engine.
  Use a presentation-layer setTimeout before dispatching the bot's chosen
  action.
- pino is the logger. Use `pino-pretty` in dev for readable output.

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
