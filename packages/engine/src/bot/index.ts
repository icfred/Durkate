import type { Card, Suit } from "../cards";
import { RANKS, SUITS } from "../cards";
import { type Rng, rngFromState } from "../rng";
import type { InRoundState, State, TablePair } from "../state";
import type { Action } from "../step";
import { beats } from "../step";

export type BotDifficulty = "easy" | "medium" | "hard";

export interface BotChooseOpts {
  difficulty?: BotDifficulty;
}

const MAX_ATTACKS_PER_BOUT = 6;
// Medium burn-trump avoidance: refuse to spend a trump rank >= TRUMP_BURN_MIN
// to cover a non-trump attack with rank <= ATTACK_BURN_MAX. Bot prefers
// taking the pile over wasting a queen-or-higher trump on a 7 or 8.
const TRUMP_BURN_MIN = 12;
const ATTACK_BURN_MAX = 8;

// Hard switches to "high non-trumps" attack pressure once opponent has
// HARD_PRESSURE_HAND or fewer cards left — i.e. only in the very late
// game where the squeeze actually matters. Pressuring earlier just
// burns hard's own high cards for no advantage.
const HARD_PRESSURE_HAND = 2;
// "Safe-high" attack: for hard to push a non-trump and force a
// trump-burn or take-pile, the card should be high enough to actually
// be expensive. Below this rank, even an undefendable non-trump isn't
// worth the squeeze.
const HARD_SAFE_HIGH_MIN_RANK = 12;

export function choose(state: State, opts?: BotChooseOpts): Action {
  if (state.phase !== "in-round") {
    throw new Error(`bot.choose requires phase 'in-round', got '${state.phase}'`);
  }
  const difficulty = opts?.difficulty ?? "medium";
  switch (difficulty) {
    case "easy":
      return chooseEasy(state);
    case "medium":
      return chooseMedium(state);
    case "hard":
      return chooseHard(state);
    default:
      difficulty satisfies never;
      throw new Error(`unknown difficulty: ${String(difficulty)}`);
  }
}

// ─── medium (current heuristic) ────────────────────────────────────────────

function chooseMedium(state: InRoundState): Action {
  const undefendedIdx = state.table.findIndex((p) => !p.defense);
  if (state.table.length === 0) return mediumOpenAttack(state);
  if (undefendedIdx >= 0) return mediumDefendOrTake(state, undefendedIdx);
  return mediumThrowInOrEnd(state);
}

function mediumOpenAttack(state: InRoundState): Action {
  const hand = state.hands[state.attacker] as Card[];
  const card = pickCheapest(hand, state.trumpSuit);
  return { type: "ATTACK", by: state.attacker, card };
}

function mediumDefendOrTake(state: InRoundState, target: number): Action {
  const hand = state.hands[state.defender] as Card[];
  const pair = state.table[target] as TablePair;
  const candidates = hand
    .filter((c) => beats(c, pair.attack, state.trumpSuit))
    .sort(cheapFirst(state.trumpSuit));
  if (candidates.length === 0) return { type: "TAKE_PILE", by: state.defender };
  const cheapest = candidates[0] as Card;
  if (wouldBurnHighTrump(pair.attack, cheapest, state.trumpSuit)) {
    return { type: "TAKE_PILE", by: state.defender };
  }
  return { type: "DEFEND", by: state.defender, card: cheapest, target };
}

function mediumThrowInOrEnd(state: InRoundState): Action {
  if (state.table.length >= MAX_ATTACKS_PER_BOUT) {
    return { type: "END_ROUND", by: state.attacker };
  }
  const defenderHand = state.hands[state.defender] as Card[];
  if (defenderHand.length < 1) return { type: "END_ROUND", by: state.attacker };
  const hand = state.hands[state.attacker] as Card[];
  const ranks = ranksOnTable(state.table);
  const candidates = hand.filter((c) => ranks.has(c.rank)).sort(cheapFirst(state.trumpSuit));
  if (candidates.length === 0) return { type: "END_ROUND", by: state.attacker };
  return { type: "THROW_IN", by: state.attacker, card: candidates[0] as Card };
}

// ─── easy (random-ish, burns trumps, takes pile easily) ────────────────────

function chooseEasy(state: InRoundState): Action {
  // Fork an RNG from state.rng so easy is deterministic per state without
  // mutating state.rng (engine purity: bot is a pure observer).
  const rng = rngFromState(state.rng);
  const undefendedIdx = state.table.findIndex((p) => !p.defense);
  if (state.table.length === 0) return easyOpenAttack(state, rng);
  if (undefendedIdx >= 0) return easyDefendOrTake(state, undefendedIdx);
  return easyThrowInOrEnd(state, rng);
}

function easyOpenAttack(state: InRoundState, rng: Rng): Action {
  const hand = state.hands[state.attacker] as Card[];
  const card = randomAttackCard(hand, state.trumpSuit, rng);
  return { type: "ATTACK", by: state.attacker, card };
}

function easyDefendOrTake(state: InRoundState, target: number): Action {
  const hand = state.hands[state.defender] as Card[];
  const pair = state.table[target] as TablePair;
  const candidates = hand
    .filter((c) => beats(c, pair.attack, state.trumpSuit))
    .sort(cheapFirst(state.trumpSuit));
  if (candidates.length === 0) return { type: "TAKE_PILE", by: state.defender };
  // No medium-style burn-trump guard: easy happily spends a high trump
  // covering a low attack.
  return { type: "DEFEND", by: state.defender, card: candidates[0] as Card, target };
}

function easyThrowInOrEnd(state: InRoundState, rng: Rng): Action {
  if (state.table.length >= MAX_ATTACKS_PER_BOUT) {
    return { type: "END_ROUND", by: state.attacker };
  }
  const defenderHand = state.hands[state.defender] as Card[];
  if (defenderHand.length < 1) return { type: "END_ROUND", by: state.attacker };
  const hand = state.hands[state.attacker] as Card[];
  const ranks = ranksOnTable(state.table);
  const candidates = hand.filter((c) => ranks.has(c.rank));
  if (candidates.length === 0) return { type: "END_ROUND", by: state.attacker };
  const card = randomAttackCard(candidates, state.trumpSuit, rng);
  return { type: "THROW_IN", by: state.attacker, card };
}

// Picks a card from the candidates with weights proportional to (rank - 5),
// preferring non-trumps. Falls back to the cheapest trump only if no
// non-trump candidate exists. Uses the supplied RNG, leaving state.rng
// untouched.
function randomAttackCard(candidates: readonly Card[], trump: Suit, rng: Rng): Card {
  const nonTrumps = candidates.filter((c) => c.suit !== trump);
  if (nonTrumps.length > 0) {
    const sorted = [...nonTrumps].sort(byRankThenSuit);
    const weights = sorted.map((c) => Math.max(1, c.rank - 5));
    return weightedPick(sorted, weights, rng);
  }
  return [...candidates].sort(cheapFirst(trump))[0] as Card;
}

function weightedPick<T>(items: readonly T[], weights: readonly number[], rng: Rng): T {
  let total = 0;
  for (const w of weights) total += w;
  let r = rng.nextInt(total);
  for (let i = 0; i < items.length; i++) {
    r -= weights[i] as number;
    if (r < 0) return items[i] as T;
  }
  return items[items.length - 1] as T;
}

// ─── hard (card-counting-lite, hoards trumps, never folds when defendable) ──

function chooseHard(state: InRoundState): Action {
  const undefendedIdx = state.table.findIndex((p) => !p.defense);
  if (state.table.length === 0) return hardOpenAttack(state);
  if (undefendedIdx >= 0) return hardDefendOrTake(state, undefendedIdx);
  return hardThrowInOrEnd(state);
}

function hardOpenAttack(state: InRoundState): Action {
  const hand = state.hands[state.attacker] as Card[];
  const oppHand = state.hands[state.defender] as Card[];
  const card = pressureAttackCard(
    hand,
    state.trumpSuit,
    oppHand.length,
    state.talon.length,
    countUnseenAbove(state, state.attacker),
  );
  return { type: "ATTACK", by: state.attacker, card };
}

function hardDefendOrTake(state: InRoundState, target: number): Action {
  const hand = state.hands[state.defender] as Card[];
  const pair = state.table[target] as TablePair;
  // Trump-hoard: prefer a same-suit non-trump beat over any trump.
  const sameSuit = hand
    .filter((c) => c.suit === pair.attack.suit && beats(c, pair.attack, state.trumpSuit))
    .sort(byRankThenSuit);
  const trumps = hand
    .filter((c) => c.suit === state.trumpSuit && beats(c, pair.attack, state.trumpSuit))
    .sort(byRankThenSuit);
  const choice = sameSuit[0] ?? trumps[0];
  if (!choice) return { type: "TAKE_PILE", by: state.defender };
  return { type: "DEFEND", by: state.defender, card: choice, target };
}

function hardThrowInOrEnd(state: InRoundState): Action {
  if (state.table.length >= MAX_ATTACKS_PER_BOUT) {
    return { type: "END_ROUND", by: state.attacker };
  }
  const defenderHand = state.hands[state.defender] as Card[];
  if (defenderHand.length < 1) return { type: "END_ROUND", by: state.attacker };
  const hand = state.hands[state.attacker] as Card[];
  const ranks = ranksOnTable(state.table);
  const candidates = hand.filter((c) => ranks.has(c.rank));
  if (candidates.length === 0) return { type: "END_ROUND", by: state.attacker };
  const card = pressureAttackCard(
    candidates,
    state.trumpSuit,
    defenderHand.length,
    state.talon.length,
    countUnseenAbove(state, state.attacker),
  );
  return { type: "THROW_IN", by: state.attacker, card };
}

// Hard's attack pressure: hoards trumps. Default is the cheapest non-
// trump (drains opponent's cheap defenses early). When hard holds a
// "safe high" non-trump — rank >= HARD_SAFE_HIGH_MIN_RANK with no
// higher same-suit card unseen — pushing it forces opponent to burn a
// trump or take the pile. In the very late endgame (talon empty,
// opponent at HARD_PRESSURE_HAND or fewer), pushes the highest non-
// trump outright. Falls back to the cheapest trump only when no non-
// trump candidate exists.
function pressureAttackCard(
  candidates: readonly Card[],
  trump: Suit,
  oppHandSize: number,
  talonSize: number,
  unseenAbove: ReadonlyMap<string, number>,
): Card {
  const nonTrumps = [...candidates].filter((c) => c.suit !== trump).sort(byRankThenSuit);
  if (nonTrumps.length === 0) {
    return [...candidates].sort(cheapFirst(trump))[0] as Card;
  }
  // Endgame-only pressure: while the talon refills, sacrificing a high
  // non-trump just trades for a covered+replenished cycle that doesn't
  // help. Once the talon is empty every card is final, so it's worth
  // forcing opponent to burn a trump or take the pile.
  if (talonSize === 0) {
    const safeHigh = nonTrumps.filter(
      (c) =>
        c.rank >= HARD_SAFE_HIGH_MIN_RANK && (unseenAbove.get(`${c.suit}-${c.rank}`) ?? 0) === 0,
    );
    if (safeHigh.length > 0) {
      return safeHigh[safeHigh.length - 1] as Card;
    }
    if (oppHandSize <= HARD_PRESSURE_HAND) {
      return nonTrumps[nonTrumps.length - 1] as Card;
    }
  }
  return nonTrumps[0] as Card;
}

// For every non-trump (suit, rank) the bot might attack with, counts how
// many strictly-higher same-suit cards remain unseen from `byPlayer`'s
// perspective. Unseen cards live in either the opponent's hand or the
// talon — when this count is zero, the opponent cannot cover with a
// same-suit beat.
function countUnseenAbove(state: InRoundState, byPlayer: number): Map<string, number> {
  const seen = new Set<string>();
  const key = (c: Card) => `${c.suit}-${c.rank}`;
  for (const c of state.hands[byPlayer] as Card[]) seen.add(key(c));
  for (const c of state.discard) seen.add(key(c));
  for (const pair of state.table) {
    seen.add(key(pair.attack));
    if (pair.defense) seen.add(key(pair.defense));
  }
  if (state.trumpCard) seen.add(key(state.trumpCard));
  const out = new Map<string, number>();
  for (const suit of SUITS) {
    if (suit === state.trumpSuit) continue;
    for (const rank of RANKS) {
      let above = 0;
      for (const r of RANKS) {
        if (r > rank && !seen.has(`${suit}-${r}`)) above++;
      }
      out.set(`${suit}-${rank}`, above);
    }
  }
  return out;
}

// ─── shared helpers ────────────────────────────────────────────────────────

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

function byRankThenSuit(a: Card, b: Card): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  return SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit);
}

function ranksOnTable(table: readonly TablePair[]): Set<number> {
  const out = new Set<number>();
  for (const pair of table) {
    out.add(pair.attack.rank);
    if (pair.defense) out.add(pair.defense.rank);
  }
  return out;
}
