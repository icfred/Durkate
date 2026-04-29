import { buildDeck, type Card, type Suit } from "./cards";
import { shuffle } from "./deck";
import { rngFromState } from "./rng";
import type { InRoundState, State } from "./state";

export type Action = { type: "START_GAME" };

export type Event = { type: "GAME_STARTED"; trump: Card; attacker: number };

export interface StepResult {
  state: State;
  events: Event[];
}

export function step(state: State, action: Action): StepResult {
  switch (action.type) {
    case "START_GAME":
      return startGame(state);
  }
}

function startGame(state: State): StepResult {
  if (state.phase !== "pre-deal") {
    throw new Error("START_GAME requires phase 'pre-deal'");
  }
  const handSize = 6;
  const dealt = state.playerCount * handSize;
  if (dealt + 1 > 36) {
    throw new RangeError("playerCount too large for a 36-card deck");
  }
  const rng = rngFromState(state.rng);
  const shuffled = shuffle(buildDeck(), rng);
  const hands: Card[][] = [];
  for (let p = 0; p < state.playerCount; p++) {
    hands.push(shuffled.slice(p * handSize, (p + 1) * handSize));
  }
  const remaining = shuffled.slice(dealt);
  const trump = remaining[remaining.length - 1] as Card;
  const talon = remaining.slice(0, -1);
  const attacker = pickAttacker(hands, trump.suit);
  const defender = (attacker + 1) % state.playerCount;
  const next: InRoundState = {
    phase: "in-round",
    playerCount: state.playerCount,
    rng: rng.state,
    hands,
    talon,
    trump,
    table: [],
    attacker,
    defender,
    discard: [],
  };
  return {
    state: next,
    events: [{ type: "GAME_STARTED", trump, attacker }],
  };
}

function pickAttacker(hands: readonly (readonly Card[])[], trumpSuit: Suit): number {
  let attacker = 0;
  let lowest = Number.POSITIVE_INFINITY;
  for (let p = 0; p < hands.length; p++) {
    for (const card of hands[p] as readonly Card[]) {
      if (card.suit === trumpSuit && card.rank < lowest) {
        lowest = card.rank;
        attacker = p;
      }
    }
  }
  return attacker;
}
