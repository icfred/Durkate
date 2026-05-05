# ADR-0011: FFA throw-in window for round-resolving actions

**Status:** Accepted
**Date:** 2026-05-05

## Context

ADR-0010 confirmed that any non-defender may throw in matching-rank cards
during a bout, but the worker still applied `END_ROUND` and `TAKE_PILE`
the moment they arrived. At N>2 the engine would resolve the round
before any non-attacker had a chance to pile on, even though the rules
grant them throw-in rights. The frontend gate was loosened in commit
`93fad59` so non-attackers can submit `THROW_IN`, but without a host-
side pacing window they were racing against the round closing.

## Decision

When the engine accepts an `END_ROUND` or `TAKE_PILE` while
`playerCount > 2`, the worker does **not** apply it immediately. It
opens a 2.5-second close window (`CLOSE_WINDOW_MS`, env-tunable). During
the window:

- `THROW_IN` from any non-defender applies through the engine and
  *resets* the window to a fresh 2.5 s. `passed[]` is cleared so every
  non-defender gets fresh consideration after a pile-on.
- `PASS { by }` (a new pure-observer engine action) appends the seat
  to `pendingClose.passed`. When every non-eliminated non-defender has
  passed, the window collapses immediately.
- Any other action — including a duplicate `END_ROUND` / `TAKE_PILE`
  or a stray `ATTACK` / `DEFEND` — is rejected with `FORBIDDEN_ACTION`.
  The pending action's parameters are stable until close.
- If the alarm fires first (no further THROW_INs, not everyone has
  passed), the worker re-issues the pending action through the engine.

Bot driver: when the window opens, every non-defender non-eliminated
bot seat is queued for fan-out. The shared `bot-think` alarm fires once
and drains all queued bots; each picks `THROW_IN` (cheapest matching-
rank card) or `PASS` (when no matching card). Per-seat staggering is a
UX nicety the single-slot AlarmScheduler doesn't provide; the spec
calls for it but in practice all bots' decisions land in the same fire.
Each `THROW_IN` extends the window and re-queues fan-out for everyone.

The `PASS` action lives in the engine (rather than the host) because
clients submit it through the same `SubmitAction` path. The engine
treats it as a pure observer: it returns the same state and emits a
`PLAYER_PASSED { by }` event; legality is enforced (defender rejected,
eliminated seats rejected, wrong phase rejected). The worker decides
whether the window is open at all.

### N=2 back-compat

The window collapses to zero at `playerCount === 2`. Rationale: the
only non-defender at N=2 is the original attacker, who already had
unbounded time to throw in cards before submitting the round-resolver.
A window would just stall the snappy 1v1 flow without giving anyone a
new opportunity. Existing 1v1 worker tests pass without modification.

The alternative — a much shorter ~200 ms window even at N=2 — was
rejected as ceremony for ceremony's sake.

## Consequences

- Engine: `Action` union gains `PASS { by }`; `Event` gains
  `PLAYER_PASSED { by }`; two new `RejectReason`s (`DEFENDER_CANNOT_PASS`,
  `ELIMINATED_CANNOT_PASS`).
- Protocol: `RoomStateMessage` gains optional `pendingClose: { kind,
  closesAt, passed } | null`. Zod and the type-parity guards updated.
- Worker: `Room` carries `pendingClose`, `pendingCloseBy`, and
  `botFanOut: Map<seat, deadline>` alongside engine state, all
  persisted. New `DeadlineKind` `"close-window"` composes with the
  existing `AlarmScheduler`. `applyAction` routes through a state
  machine that distinguishes window-open from window-closed.
- Web: `GameScreen` renders a countdown banner reading "Round closing
  in N.Ns…" / "Pile collected in N.Ns…" while `appStore.room
  .pendingClose` is non-null. Local seat hint adds "P: pass" during the
  window. Pressing P submits `PASS`. Banner clears when the next
  RoomState reports `pendingClose: null`.
- Tests: a new `apps/worker/src/room-close-window.test.ts` covers the
  pending-close lifecycle (open, extend on THROW_IN, alarm fire, bot
  fan-out, N=2 collapse, PASS legality). Engine tests for `PASS`
  legality. Web tests for the countdown banner and the PASS keystroke.
  Default test environment sets `CLOSE_WINDOW_MS=0` so existing end-
  to-end flows aren't slowed by the 2.5 s pacing; window-aware tests
  opt in via `testSetCloseWindowMs(...)`.

## Rejected alternatives

- **Per-seat alarm slots for fan-out.** Would let bots stagger their
  decisions visibly. Out of scope: the AlarmScheduler is a single-slot
  abstraction (one platform alarm per kind); growing it to multi-slot
  per kind for a UX-only nicety wasn't worth the surface-area increase.
- **Force the human attacker to PASS even when they originally
  submitted END_ROUND.** Confusing UX — the attacker said "end now",
  asking them to confirm again is friction. The window is purely for
  *other* non-defenders.
- **Engine-level FORFEIT-style synthesis of the pending action.**
  Mirrors ADR-0009's pattern but isn't needed here: the action is the
  user's own legal submission, just deferred by host-side pacing. The
  engine's `END_ROUND` / `TAKE_PILE` paths fire unchanged when the
  window expires.

## Out of scope

- Per-seat configurable window.
- Auto-pass for the local human after a brief idle period when their
  hand has no matching rank — the explicit "P" key suffices for MVP.
- Allowing the defender to take an *intermediate* card mid-window;
  defender's choice is final once the window opens.
- Multi-round score-keeping.
