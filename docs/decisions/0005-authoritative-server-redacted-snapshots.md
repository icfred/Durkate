# ADR-0005: Authoritative server with redacted per-player snapshots and events

**Status:** Accepted
**Date:** 2026-04-29

## Context

The game is real-time websocket multiplayer, public from day one, with
strangers eventually playing. Cheating (seeing opponent hands, replaying
deck order, forging actions) must be infeasible without compromising the
server. Two dimensions need decisions: (a) how the server prevents cheating,
(b) how state is synced to clients.

## Options considered

### Sync style

1. **Full snapshots** - server emits complete state on every change.
   Simple, robust, no drift.
2. **Event-only** - server emits events, client folds. Bandwidth-efficient,
   but client must implement every transition correctly. Drift risk.
3. **Snapshot + events** - server emits both. Snapshots render the table;
   events drive animations and SFX cues.

### Anti-cheat shape

1. Authoritative server validates every inbound action through the engine.
2. Per-player redacted snapshots: each client receives a view that excludes
   information the player should not have (opponent hand contents, deck
   contents, RNG state).
3. RNG and timers live server-side only.
4. Inbound messages validated by Zod; per-connection rate limit.
5. Session token bound to seat; ws upgrade carries the token.

## Decision

- **Sync style:** snapshot + events. The engine returns events as a side
  product (ADR-0002), so emitting them is free and animations need them.
- **Anti-cheat:** all five rules above are baked into protocol and server
  design. Not a library, just architectural discipline.

## Consequences

- Each ws message from the server is `{ snapshot, events }` for the seat it
  is destined to. Two players in a room receive different snapshots from
  the same authoritative state.
- Server holds the seed; client never sees deck contents or RNG.
- Server enforces turn timers and emits `TIMEOUT` actions to itself.
- All inbound ws messages are Zod-parsed; malformed messages drop the
  connection. Rate limit per connection prevents flooding.
- Session tokens issued at room-join attribute every action to a specific
  seat. No "play as the other player" via spoofing.
- Cheating requires server compromise, not client compromise.
