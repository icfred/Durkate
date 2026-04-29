import type { Card, Suit } from "../cards";
import { SUITS } from "../cards";
import type { InRoundState, State, TablePair } from "../state";
import type { Action } from "../step";
import { beats } from "../step";

const MAX_ATTACKS_PER_BOUT = 6;
// Burn-trump avoidance: refuse to spend a trump rank >= TRUMP_BURN_MIN to
// cover a non-trump attack with rank <= ATTACK_BURN_MAX. Bot prefers taking
// the pile over wasting a queen-or-higher trump on a 7 or 8.
const TRUMP_BURN_MIN = 12;
const ATTACK_BURN_MAX = 8;

export function choose(state: State): Action {
  if (state.phase !== "in-round") {
    throw new Error(`bot.choose requires phase 'in-round', got '${state.phase}'`);
  }
  const undefendedIdx = state.table.findIndex((p) => !p.defense);
  if (state.table.length === 0) return chooseOpenAttack(state);
  if (undefendedIdx >= 0) return chooseDefendOrTake(state, undefendedIdx);
  return chooseThrowInOrEnd(state);
}

function chooseOpenAttack(state: InRoundState): Action {
  const hand = state.hands[state.attacker] as Card[];
  const card = pickCheapest(hand, state.trumpSuit);
  return { type: "ATTACK", by: state.attacker, card };
}

function chooseDefendOrTake(state: InRoundState, target: number): Action {
  const hand = state.hands[state.defender] as Card[];
  const pair = state.table[target] as TablePair;
  const candidates = hand
    .filter((c) => beats(c, pair.attack, state.trumpSuit))
    .sort(cheapFirst(state.trumpSuit));
  if (candidates.length === 0) {
    return { type: "TAKE_PILE", by: state.defender };
  }
  const cheapest = candidates[0] as Card;
  if (wouldBurnHighTrump(pair.attack, cheapest, state.trumpSuit)) {
    return { type: "TAKE_PILE", by: state.defender };
  }
  return { type: "DEFEND", by: state.defender, card: cheapest, target };
}

function chooseThrowInOrEnd(state: InRoundState): Action {
  if (state.table.length >= MAX_ATTACKS_PER_BOUT) {
    return { type: "END_ROUND", by: state.attacker };
  }
  const defenderHand = state.hands[state.defender] as Card[];
  if (defenderHand.length < 1) {
    return { type: "END_ROUND", by: state.attacker };
  }
  const hand = state.hands[state.attacker] as Card[];
  const ranks = ranksOnTable(state.table);
  const candidates = hand.filter((c) => ranks.has(c.rank)).sort(cheapFirst(state.trumpSuit));
  if (candidates.length === 0) {
    return { type: "END_ROUND", by: state.attacker };
  }
  return { type: "THROW_IN", by: state.attacker, card: candidates[0] as Card };
}

function wouldBurnHighTrump(attack: Card, defense: Card, trump: Suit): boolean {
  if (attack.suit === trump) return false;
  if (defense.suit !== trump) return false;
  return attack.rank <= ATTACK_BURN_MAX && defense.rank >= TRUMP_BURN_MIN;
}

function pickCheapest(hand: readonly Card[], trump: Suit): Card {
  return [...hand].sort(cheapFirst(trump))[0] as Card;
}

function cheapFirst(trump: Suit): (a: Card, b: Card) => number {
  return (a, b) => {
    const trumpA = a.suit === trump ? 1 : 0;
    const trumpB = b.suit === trump ? 1 : 0;
    if (trumpA !== trumpB) return trumpA - trumpB;
    if (a.rank !== b.rank) return a.rank - b.rank;
    return SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit);
  };
}

function ranksOnTable(table: readonly TablePair[]): Set<number> {
  const out = new Set<number>();
  for (const pair of table) {
    out.add(pair.attack.rank);
    if (pair.defense) out.add(pair.defense.rank);
  }
  return out;
}
