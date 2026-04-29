# ADR-0003: Determinism strategy

**Status:** Accepted
**Date:** 2026-04-29

## Context

The engine must be deterministic: same initial state + same action sequence =
same result. Determinism enables fast tests, reproducible bot behavior,
authoritative server validation, golden-file game traces, and future replay.
Two non-determinism sources need to be removed from the engine: randomness
and time.

## Options considered

### Randomness

1. **Inject seeded RNG into engine state** - state carries a PRNG. Every
   random op pulls from it. Engine never calls `Math.random()`.
2. **Pass an RNG function per call** - more flexible, but the seed escapes
   state and replay needs out-of-band tracking.
3. **Inline `Math.random()`** - non-deterministic. Rejected.

### Time

1. **Engine takes time as input** - the engine sees actions, never the
   clock. The server tracks turn timers and emits a synthetic `TIMEOUT`
   action when a timer expires; the engine just sees the action.
2. **Engine reads the clock** - non-deterministic. Rejected.

## Decision

- Engine carries a seeded PRNG inside state. The seed is part of the initial
  state and the event log.
- Engine is time-free. The server owns turn timers and emits `TIMEOUT`
  actions that flow through the engine like any other action.
- Bot delays for player comprehensibility live on the server (or client) as
  a presentation-layer `setTimeout` before the bot's chosen action is
  dispatched. Bot delay does not enter the engine.

## Consequences

- Property tests (fast-check) and golden-file traces reproduce reliably.
- Server is the only entity that holds the seed; clients never see deck
  contents or RNG state.
- Bot evaluation is deterministic given (state, seed).
- Adding a new random operation requires routing through the seeded PRNG -
  enforced by lint rule "no `Math.random` in `packages/engine`".
- Adding a new time-dependent rule requires the server to emit a synthetic
  action - enforced by code review and the same forbidden list.
