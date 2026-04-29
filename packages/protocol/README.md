# @durak/protocol

## Purpose

Wire types and Zod schemas shared by `apps/web` and `apps/server`. Defines
every websocket message in either direction. Server uses Zod schemas to
validate inbound messages; client uses TS types for outbound.

## Key concepts

- **ClientMessage**: tagged union of messages sent from client to server.
  Variants: `JoinRoom`, `LeaveRoom`, `SubmitAction`, `RequestRematch`.
  `SubmitAction.action` is the engine `Action` type from `@durak/engine`.
- **ServerMessage**: tagged union of messages sent from server to client.
  Variants: `Snapshot`, `Events`, `Error`, `RoomState`.
- **Snapshot**: per-seat redacted view of in-round state. Mirrors the
  engine `InRoundState` minus `talon` contents (only `talonCount`),
  minus opponent hand contents (only `handCounts`), minus `rng`. Adds
  `seat` and `you: { hand, seat }`.

## Public API

Types: `ClientMessage`, `JoinRoom`, `LeaveRoom`, `SubmitAction`,
`RequestRematch`, `ServerMessage`, `SnapshotMessage`, `EventsMessage`,
`ErrorMessage`, `RoomStateMessage`, `RoomSeat`, `Snapshot`, `YouView`,
`SeatIndex`.

Schemas (Zod, inbound only): `clientMessageSchema`, `joinRoomSchema`,
`leaveRoomSchema`, `submitActionSchema`, `requestRematchSchema`.

Helpers: `parseClientMessage(raw)`.

## Invariants

- Every inbound client message is parsed by Zod before any processing.
- Outbound server messages are TypeScript-typed; no runtime validation
  needed (server controls output).
- `Snapshot` does not name `talon`, `hands`, or `rng` as keys (enforced
  by a compile-time type guard in `snapshot.ts`).
- Schema/type parity: each Zod schema's `z.infer` is type-equal to its
  TS variant (enforced by compile-time guards in `zod.ts`).

## Gotchas

- This package has zero runtime deps beyond Zod. It must be importable in
  both Node (server) and browser (client) environments.

## Related ADRs

- ADR-0005: authoritative server with redacted snapshots and events
