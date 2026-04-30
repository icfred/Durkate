# ADR-0010: N-player FFA rules (3-6 seats)

**Status:** Accepted
**Date:** 2026-04-30

## Context

The vision (`docs/project_vision.md`) and MVP doc (`docs/project_mvp.md`)
flag 3-6 player FFA as post-MVP. The engine has carried `playerCount` and
arrayed hands from day one, but only 1v1 was tested and the rotation /
elimination semantics for N>2 had never been pinned down.

Three rule choices have to be made before the engine can claim N-player
support:

1. **Throw-in rights.** Who, beyond the original attacker, may add cards
   to a bout once it is open?
2. **Game-over semantics.** When does the engine stop, and what happens
   to a seat whose hand empties before the talon does?
3. **Seat-attack rotation.** Where do the attacker / defender roles land
   after `END_ROUND` (clean defense) and `TAKE_PILE` (defender folds)?

The rotation question is the load-bearing one. With more than two seats,
"the seat to the left" and "the next non-eliminated seat" stop coinciding
the moment the first player runs out of cards.

## Decision

### 1. Throw-in rights: standard Podkidnoy

Any non-defender seat may throw in a card whose rank is already on the
table, subject to the existing constraints (max 6 attacks per bout, the
defender must hold enough cards to keep covering).

Implementation already permitted any seat with `by !== state.defender`.
This ADR confirms it as the rule and adds a multi-seat throw-in test at
N=4 that exercises seats 0, 2, and 3 against defender 1.

### 2. Game-over semantics: eliminate-as-they-empty, last-with-cards is durak

The game continues until exactly one seat still holds cards, or every
seat empties on the same transition (draw). Seats that run out mid-game
become **spectators**: their hand stays at zero, the engine emits a
`PLAYER_OUT { seat }` event the moment they go empty (with the talon
also exhausted), and subsequent rotations skip them.

`PLAYER_OUT` is a one-shot event per seat per game. It fires from the
action that pushes the seat over the line - `DEFEND` if the defender's
last card was a successful cover, `ATTACK` / `THROW_IN` if the playing
seat ran out, `END_ROUND` / `TAKE_PILE` if the talon ran dry mid-
replenishment leaving the seat at zero. The engine compares
"eliminated seats" before and after each transition and emits one event
per seat that crossed the threshold.

`GAME_OVER` still fires last in the events list of the transition that
ends the game.

A bonus consequence flagged in the ticket - **once only bots remain
in the active set, the host autoplays at 2x speed** - is a host-side
pacing concern, not an engine concern. It will land in the worker
ticket. The engine continues to step uniformly regardless of who is
behind each seat.

### 3. Seat-attack rotation: defender +1 / +2

Standard Podkidnoy.

- `END_ROUND` (defender beats off all attacks): the defender becomes
  the next attacker, attacking the seat to their left. Equivalently,
  the defender role rotates by +1 from the previous defender.
- `TAKE_PILE` (defender folds): the defender is skipped on the next
  bout. The next attacker is the seat after the defender, the new
  defender is the seat after that. The defender role rotates by +2.

Both rotations skip eliminated seats. With 4 seats and seat 2 already
out, an `END_ROUND` whose previous defender was seat 0 lands attacker=
seat 0, defender=seat 2 → defender=seat 3 (skip 2). A `TAKE_PILE` with
prevDefender=1 and seat 2 eliminated lands attacker=seat 3 (not seat
2), defender=seat 0.

When only one active seat remains the rotation is degenerate; the
engine emits "naive" attacker/defender values on the terminal
`ROUND_ENDED` / `PILE_TAKEN` event but the state is `game-over` so the
values are never consumed for further play.

## Rejected alternatives

- **Adjacency-only throw-in** (only the seats immediately left and
  right of the defender may throw in). Common in some house rules but
  not Podkidnoy; would force callers to know seat geometry to validate.
- **First-to-empty wins, last-to-empty is durak** (single-shot
  evaluation at game end). Saves the eliminate-as-they-empty
  bookkeeping but breaks the spectator UX - players who run out early
  would have to keep "playing" empty hands until the round ends.
- **Skip eliminated seats in throw-in but not rotation.** Rejected
  because rotation that lands on an eliminated seat is just a bug;
  there is no game-design reason to keep an empty seat in the active
  pair.

## Consequences

- `packages/engine/src/step.ts` carries a `rotateRoles` helper that
  walks forward from `prevDefender` skipping eliminated seats, an
  `eliminatedSeatsOf` predicate, and `newlyOutEvents` that emits
  `PLAYER_OUT` from any action that pushes a seat into the eliminated
  set.
- `Event` gains a `PLAYER_OUT { seat: number }` variant. Server and
  client must handle it (drive a "player X is out" cue). Until the
  worker / web tickets land, both layers can ignore it without losing
  correctness.
- The 6-player edge case (`6 * 6 = 36`) is supported by treating the
  last-dealt card as the trump indicator: it stays in the last seat's
  hand, the engine carries `trumpSuit` and `trumpCard: null`. The
  `GAME_STARTED` event still surfaces the indicator card so the
  client can render it face-up. `playerCount > 6` still throws.
- Property tests run game-over termination and card-conservation
  invariants at N=2, 3, 4, 5, 6. Golden traces are committed at
  N=2, 4, 6 from a fixed seed via the deterministic chooser used
  for the existing 1v1 trace.
- The bot (`packages/engine/src/bot/`) was already a pure observer
  that only references `state.attacker` and `state.defender`, so it
  works at N>2 unchanged. The N-player property tests cover bot-
  driven self-play through the deterministic chooser, not the bot's
  own heuristics, so the bot's strength at N>2 is not yet measured.
  That is post-MVP work.

## Out of scope

- Worker support for N seats and multi-bot rooms (tracked separately).
- Web UI for N-player table layout and spectator rendering.
- Lobby UX for N-player rooms.
- 2x autoplay when only bots remain (worker ticket).
