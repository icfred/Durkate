import type { SeatIndex, SnapshotMessage } from "@durak/protocol";

export function stubSnapshotMessage(seat: SeatIndex): SnapshotMessage {
  return {
    type: "Snapshot",
    snapshot: {
      phase: "in-round",
      playerCount: 2,
      handCounts: [6, 6],
      talonCount: 24,
      trump: { suit: "spades", rank: 6 },
      table: [],
      attacker: 0,
      defender: 1,
      discard: [],
      seat,
      you: { seat, hand: [] },
    },
  };
}
