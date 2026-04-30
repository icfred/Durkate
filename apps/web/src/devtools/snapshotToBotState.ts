import type { Card, InRoundState } from "@durak/engine";
import type { Snapshot } from "@durak/protocol";

/**
 * Build a partial engine `InRoundState` from a redacted Snapshot, suitable
 * for `bot.choose`. The bot only reads the active seat's actual hand and
 * the inactive seats' hand *length*; we fill placeholders for those so the
 * cardinality is right without leaking opponent cards (the snapshot does
 * not carry them anyway). `rng` and `talon` are inert from the bot's POV
 * but the type insists on them.
 */
export function snapshotToBotState(snapshot: Snapshot): InRoundState {
  const placeholder: Card = { suit: snapshot.trumpSuit, rank: 6 };
  const hands: Card[][] = [];
  for (let i = 0; i < snapshot.playerCount; i++) {
    if (i === snapshot.you.seat) {
      hands.push([...snapshot.you.hand]);
    } else {
      const count = snapshot.handCounts[i] ?? 0;
      hands.push(Array.from({ length: count }, () => ({ ...placeholder })));
    }
  }
  return {
    phase: "in-round",
    playerCount: snapshot.playerCount,
    rng: [1, 2, 3, 4] as const,
    hands,
    talon: [],
    trumpSuit: snapshot.trumpSuit,
    trumpCard: snapshot.trump,
    table: snapshot.table,
    attacker: snapshot.attacker,
    defender: snapshot.defender,
    discard: snapshot.discard,
  };
}

/**
 * True if the local seat is the one expected to act next: attacker on an
 * empty/full table, defender on an undefended attack.
 */
export function isYourTurn(snapshot: Snapshot): boolean {
  const you = snapshot.you.seat;
  const undefended = snapshot.table.some((p) => !p.defense);
  if (undefended) return you === snapshot.defender;
  return you === snapshot.attacker;
}
