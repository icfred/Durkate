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

## Related ADRs

- ADR-0003: determinism strategy
- ADR-0005: authoritative server with redacted snapshots and events
