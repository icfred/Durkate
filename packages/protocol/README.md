# @durak/protocol

## Purpose

Wire types and Zod schemas shared by `apps/web` and `apps/server`. Defines
every websocket message in either direction. Server uses Zod schemas to
validate inbound messages; client uses TS types for outbound.

## Key concepts

- **ClientMessage**: tagged union of messages sent from client to server
  (e.g. `JOIN_ROOM`, `PLAY_CARD`, `TAKE_PILE`).
- **ServerMessage**: tagged union of messages sent from server to client
  (e.g. `STATE_UPDATE` carrying `{ snapshot, events }`).
- **Snapshot**: per-player redacted view of game state. Produced by the
  server, never sent in raw engine form.

## Public API

- `ClientMessage` / `ServerMessage` types.
- `clientMessageSchema` / `serverMessageSchema` Zod schemas.
- `parseClientMessage(raw)` helper.

## Invariants

- Every inbound server message is parsed by Zod before any processing.
- Outbound server messages are TypeScript-typed; no runtime validation
  needed (server controls output).
- Hidden information (opponent hand contents, deck, RNG state) never
  appears in any message type.

## Gotchas

- This package has zero runtime deps beyond Zod. It must be importable in
  both Node (server) and browser (client) environments.

## Related ADRs

- ADR-0005: authoritative server with redacted snapshots and events
