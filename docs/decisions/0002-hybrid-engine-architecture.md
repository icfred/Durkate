# ADR-0002: Hybrid engine architecture (pure reducer + emitted events)

**Status:** Accepted
**Date:** 2026-04-29

## Context

The Durak rules engine is the load-bearing piece of this codebase. The bot
uses it for validation and lookahead, the server uses it as the
authoritative game model, and post-MVP replay/debug tooling will replay
actions through it. Three styles were on the table.

## Options considered

1. **Pure reducer** - `step(state, action) -> state`. Simple, fast,
   testable. No event log; debugging and replay derive from comparing
   states.
2. **Event-sourced** - state is the fold of all events from the initial
   state. Replay and audit are free. Every read needs the fold or a cache;
   bot lookahead is awkward (forks must replay).
3. **Hybrid** - `step(state, action) -> { state, events }`. State is the
   source of truth. Events are a side product describing what changed,
   suitable for animation cues, SFX triggers, debug logs, and post-MVP
   replay.

## Decision

Hybrid. The engine returns both the next state and the events emitted by the
transition.

## Consequences

- Bot lookahead is cheap: clone state, call `step`, evaluate.
- Server emits events to clients alongside snapshots. Animation/SFX layer
  reads the event stream; renderer reads the snapshot.
- A future replay feature can serialize the action log + initial seed and
  replay through the engine.
- Slight extra code per transition (build the event list). Acceptable.
- Engine remains pure: no I/O, no `Math.random()`, no wall clock. Determinism
  is enforced by ADR-0003.
