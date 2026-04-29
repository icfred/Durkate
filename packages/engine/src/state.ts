import type { Card, Suit } from "./cards";
import { createRng, type RngState } from "./rng";

export interface TablePair {
  attack: Card;
  defense?: Card;
}

export interface PreDealState {
  phase: "pre-deal";
  playerCount: number;
  rng: RngState;
}

export interface InRoundState {
  phase: "in-round";
  playerCount: number;
  rng: RngState;
  hands: Card[][];
  talon: Card[];
  trumpSuit: Suit;
  // The visible trump card kept face-up under the talon. During
  // replenishment the talon is drawn first; `trumpCard` is the last
  // drawable card. Once drawn it becomes part of a hand and this is
  // set to `null`. The `trumpSuit` persists for `beats` checks.
  trumpCard: Card | null;
  table: TablePair[];
  attacker: number;
  defender: number;
  discard: Card[];
}

export interface GameOverState {
  phase: "game-over";
  playerCount: number;
  rng: RngState;
  hands: Card[][];
  trumpSuit: Suit;
  trumpCard: Card | null;
  discard: Card[];
  // The seat left holding cards when no replenishment is possible.
  // `null` indicates a draw (every seat emptied on the same transition).
  durak: number | null;
}

export type State = PreDealState | InRoundState | GameOverState;

export interface InitOpts {
  seed: number;
  playerCount?: number;
}

export function initialState(opts: InitOpts): PreDealState {
  const playerCount = opts.playerCount ?? 2;
  if (!Number.isInteger(playerCount) || playerCount < 2) {
    throw new RangeError("playerCount must be an integer >= 2");
  }
  const rng = createRng(opts.seed);
  return {
    phase: "pre-deal",
    playerCount,
    rng: rng.state,
  };
}
