# ADR-0008: Trump nullability in Snapshot

**Status:** Accepted
**Date:** 2026-04-29

## Context

In Podkidnoy Durak the trump card is dealt face-up under the talon at the
start of the game. The trump *suit* is fixed for the duration. The trump
*card* itself is the last card drawn from the talon during late-game
replenishment - once the talon is exhausted, that physical card moves
into a player's hand and the table no longer has a visible trump card,
even though trump-suit beats logic still applies.

The engine (DUR-9) models this correctly: `state.trumpCard: Card | null`
plus an always-present `state.trumpSuit: Suit`. The protocol initially
declared `Snapshot.trump: Card` (non-null), which forced the redactor
(DUR-18) to synthesize a fake low-rank card from the trump suit when the
real trump card had been drawn. That worked but was a lie - the renderer
would render a card that no player actually held.

## Options considered

1. **Keep `Snapshot.trump: Card` non-null, synthesize a placeholder when
   the trump is drawn.** Hides the late-game state from the renderer.
   Easy, but lies. Eventually surprises whoever reads the field.
2. **`Snapshot.trump: Card | null` plus `Snapshot.trumpSuit: Suit`.**
   Mirrors the engine state. Renderer can show the card while it's on
   the table and a suit badge once it has been drawn.
3. **Drop `trump` entirely; only ship `trumpSuit`.** Lossy - the
   pre-late-game UI wants to render the actual card under the talon.

## Decision

Option 2. `Snapshot.trump: Card | null` plus `Snapshot.trumpSuit: Suit`.
The redactor maps `state.trumpCard` and `state.trumpSuit` directly with
no synthesis. The web GameScreen renders the trump card under the talon
when `trump !== null` and a suit-glyph badge in the same slot when
`trump === null`.

## Consequences

- Protocol shape (`packages/protocol/src/snapshot.ts`) carries both
  fields. Zod schema accepts `trump: Card | null`.
- Server `redactFor` is honest: `trump: state.trumpCard`,
  `trumpSuit: state.trumpSuit`. No synthesized fallback.
- Client renderer must handle both states. The pre-DUR-35 `talonCount +
  1` math (which always reserved a slot for the trump card under the
  talon) becomes `talon.length + (trumpCard !== null ? 1 : 0)`.
- Fixtures and tests must include `trumpSuit` for every `Snapshot`. A
  fixture exercising the `trump === null` late-game state is required
  to keep the renderer honest.
- This evolves but does not contradict ADR-0005. The redacted
  per-player snapshot still excludes opponent hands, talon contents,
  and the RNG seed - what changes is that the trump card field can now
  legitimately be `null` when the engine state says so.
