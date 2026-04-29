import type { Card } from "./cards";
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
  trump: Card;
  table: TablePair[];
  attacker: number;
  defender: number;
  discard: Card[];
}

export type State = PreDealState | InRoundState;

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
