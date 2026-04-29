import type { State } from "@durak/engine";
import type { SeatIndex, Snapshot } from "@durak/protocol";

export class RedactionPhaseError extends Error {
  constructor(phase: string) {
    super(`redactFor: cannot redact phase '${phase}'`);
    this.name = "RedactionPhaseError";
  }
}

export function redactFor(state: State, seat: SeatIndex): Snapshot {
  if (state.phase !== "in-round") {
    throw new RedactionPhaseError(state.phase);
  }
  if (!Number.isInteger(seat) || seat < 0 || seat >= state.playerCount) {
    throw new RangeError(`invalid seat: ${seat}`);
  }
  const hand = state.hands[seat];
  if (!hand) throw new RangeError(`invalid seat: ${seat}`);
  return {
    phase: "in-round",
    playerCount: state.playerCount,
    handCounts: state.hands.map((h) => h.length),
    talonCount: state.talon.length + (state.trumpCard !== null ? 1 : 0),
    trump: state.trumpCard,
    trumpSuit: state.trumpSuit,
    table: state.table.map((p) =>
      p.defense !== undefined ? { attack: p.attack, defense: p.defense } : { attack: p.attack },
    ),
    attacker: state.attacker,
    defender: state.defender,
    discard: [...state.discard],
    seat,
    you: { seat, hand: [...hand] },
  };
}
