import type { Card, Suit, TablePair } from "@durak/engine";

export type SeatIndex = number;

export interface YouView {
  seat: SeatIndex;
  hand: Card[];
}

export interface Snapshot {
  phase: "in-round";
  playerCount: number;
  handCounts: number[];
  talonCount: number;
  // The visible trump card under the talon, or `null` once it has been
  // drawn into a hand. `trumpSuit` always carries the suit so renderers
  // and `beats` checks have an answer either way.
  trump: Card | null;
  trumpSuit: Suit;
  table: TablePair[];
  attacker: SeatIndex;
  defender: SeatIndex;
  discard: Card[];
  seat: SeatIndex;
  you: YouView;
}

// Redaction invariant (ADR-0005): Snapshot must not name secret fields
// from the engine state. If a refactor adds `talon`, `hands`, or `rng`
// as a key on Snapshot, these type-level checks fail to compile.
type _NoTalon = "talon" extends keyof Snapshot ? never : true;
type _NoHands = "hands" extends keyof Snapshot ? never : true;
type _NoRng = "rng" extends keyof Snapshot ? never : true;
const _redactionInvariant: _NoTalon & _NoHands & _NoRng = true;
void _redactionInvariant;
