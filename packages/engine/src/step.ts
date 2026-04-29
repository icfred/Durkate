import { buildDeck, type Card, type Suit } from "./cards";
import { shuffle } from "./deck";
import { rngFromState } from "./rng";
import type { GameOverState, InRoundState, State, TablePair } from "./state";

export type Action =
  | { type: "START_GAME" }
  | { type: "ATTACK"; by: number; card: Card }
  | { type: "DEFEND"; by: number; card: Card; target: number }
  | { type: "THROW_IN"; by: number; card: Card }
  | { type: "TAKE_PILE"; by: number }
  | { type: "END_ROUND"; by: number }
  | { type: "TIMEOUT"; by: number };

export type RejectReason =
  | "WRONG_PHASE"
  | "INVALID_SEAT"
  | "NOT_ATTACKER"
  | "NOT_DEFENDER"
  | "DEFENDER_CANNOT_ATTACK"
  | "CARD_NOT_IN_HAND"
  | "TABLE_NOT_EMPTY"
  | "TABLE_EMPTY"
  | "RANK_NOT_ON_TABLE"
  | "ATTACK_LIMIT_REACHED"
  | "DEFENDER_OVERWHELMED"
  | "INVALID_TARGET"
  | "TARGET_ALREADY_DEFENDED"
  | "DOES_NOT_BEAT"
  | "ATTACKS_UNDEFENDED"
  | "TIMEOUT_NOT_ACTIVE_SEAT";

export type Event =
  | { type: "GAME_STARTED"; trump: Card; attacker: number }
  | {
      type: "CARD_PLAYED";
      by: number;
      role: "ATTACK" | "DEFEND" | "THROW_IN";
      card: Card;
      target?: number;
    }
  | {
      type: "PILE_TAKEN";
      by: number;
      cards: Card[];
      attacker: number;
      defender: number;
    }
  | {
      type: "ROUND_ENDED";
      discarded: Card[];
      attacker: number;
      defender: number;
    }
  | { type: "TALON_DRAWN"; by: number; cards: Card[] }
  | { type: "GAME_OVER"; durak: number | null };

export type StepResult =
  | { ok: true; state: State; events: Event[] }
  | { ok: false; reason: RejectReason };

const HAND_TARGET = 6;
const MAX_ATTACKS_PER_BOUT = 6;

export function step(state: State, action: Action): StepResult {
  switch (action.type) {
    case "START_GAME":
      return startGame(state);
    case "ATTACK":
      return attack(state, action);
    case "DEFEND":
      return defend(state, action);
    case "THROW_IN":
      return throwIn(state, action);
    case "TAKE_PILE":
      return takePile(state, action);
    case "END_ROUND":
      return endRound(state, action);
    case "TIMEOUT":
      return timeout(state, action);
    default: {
      action satisfies never;
      throw new Error(`unknown action: ${(action as { type: string }).type}`);
    }
  }
}

function startGame(state: State): StepResult {
  if (state.phase !== "pre-deal") {
    throw new Error("START_GAME requires phase 'pre-deal'");
  }
  const dealt = state.playerCount * HAND_TARGET;
  if (dealt + 1 > 36) {
    throw new RangeError("playerCount too large for a 36-card deck");
  }
  const rng = rngFromState(state.rng);
  const shuffled = shuffle(buildDeck(), rng);
  const hands: Card[][] = [];
  for (let p = 0; p < state.playerCount; p++) {
    hands.push(shuffled.slice(p * HAND_TARGET, (p + 1) * HAND_TARGET));
  }
  const remaining = shuffled.slice(dealt);
  const trumpCard = remaining[remaining.length - 1] as Card;
  const talon = remaining.slice(0, -1);
  const attacker = pickAttacker(hands, trumpCard.suit);
  const defender = (attacker + 1) % state.playerCount;
  const next: InRoundState = {
    phase: "in-round",
    playerCount: state.playerCount,
    rng: rng.state,
    hands,
    talon,
    trumpSuit: trumpCard.suit,
    trumpCard,
    table: [],
    attacker,
    defender,
    discard: [],
  };
  return {
    ok: true,
    state: next,
    events: [{ type: "GAME_STARTED", trump: trumpCard, attacker }],
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

function attack(state: State, action: { type: "ATTACK"; by: number; card: Card }): StepResult {
  if (state.phase !== "in-round") return { ok: false, reason: "WRONG_PHASE" };
  if (action.by !== state.attacker) return { ok: false, reason: "NOT_ATTACKER" };
  if (state.table.length > 0) return { ok: false, reason: "TABLE_NOT_EMPTY" };
  const hand = handOf(state, action.by);
  const handIdx = findCardIndex(hand, action.card);
  if (handIdx < 0) return { ok: false, reason: "CARD_NOT_IN_HAND" };
  if (handOf(state, state.defender).length < 1) {
    return { ok: false, reason: "DEFENDER_OVERWHELMED" };
  }
  const next = withPlayedAttack(state, action.by, handIdx, action.card);
  return {
    ok: true,
    state: next,
    events: [{ type: "CARD_PLAYED", by: action.by, role: "ATTACK", card: action.card }],
  };
}

function throwIn(state: State, action: { type: "THROW_IN"; by: number; card: Card }): StepResult {
  if (state.phase !== "in-round") return { ok: false, reason: "WRONG_PHASE" };
  if (!isValidSeat(state, action.by)) return { ok: false, reason: "INVALID_SEAT" };
  if (action.by === state.defender) return { ok: false, reason: "DEFENDER_CANNOT_ATTACK" };
  if (state.table.length === 0) return { ok: false, reason: "TABLE_EMPTY" };
  const hand = handOf(state, action.by);
  const handIdx = findCardIndex(hand, action.card);
  if (handIdx < 0) return { ok: false, reason: "CARD_NOT_IN_HAND" };
  if (!ranksOnTable(state.table).has(action.card.rank)) {
    return { ok: false, reason: "RANK_NOT_ON_TABLE" };
  }
  if (state.table.length + 1 > MAX_ATTACKS_PER_BOUT) {
    return { ok: false, reason: "ATTACK_LIMIT_REACHED" };
  }
  const undefended = state.table.reduce((n, p) => (p.defense ? n : n + 1), 0);
  if (undefended + 1 > handOf(state, state.defender).length) {
    return { ok: false, reason: "DEFENDER_OVERWHELMED" };
  }
  const next = withPlayedAttack(state, action.by, handIdx, action.card);
  return {
    ok: true,
    state: next,
    events: [{ type: "CARD_PLAYED", by: action.by, role: "THROW_IN", card: action.card }],
  };
}

function defend(
  state: State,
  action: { type: "DEFEND"; by: number; card: Card; target: number },
): StepResult {
  if (state.phase !== "in-round") return { ok: false, reason: "WRONG_PHASE" };
  if (action.by !== state.defender) return { ok: false, reason: "NOT_DEFENDER" };
  if (
    !Number.isInteger(action.target) ||
    action.target < 0 ||
    action.target >= state.table.length
  ) {
    return { ok: false, reason: "INVALID_TARGET" };
  }
  const pair = state.table[action.target];
  if (!pair) return { ok: false, reason: "INVALID_TARGET" };
  if (pair.defense !== undefined) return { ok: false, reason: "TARGET_ALREADY_DEFENDED" };
  const hand = handOf(state, action.by);
  const handIdx = findCardIndex(hand, action.card);
  if (handIdx < 0) return { ok: false, reason: "CARD_NOT_IN_HAND" };
  if (!beats(action.card, pair.attack, state.trumpSuit)) {
    return { ok: false, reason: "DOES_NOT_BEAT" };
  }
  const next = withPlayedDefense(state, action.by, handIdx, action.target, action.card);
  return {
    ok: true,
    state: next,
    events: [
      {
        type: "CARD_PLAYED",
        by: action.by,
        role: "DEFEND",
        card: action.card,
        target: action.target,
      },
    ],
  };
}

function takePile(state: State, action: { type: "TAKE_PILE"; by: number }): StepResult {
  if (state.phase !== "in-round") return { ok: false, reason: "WRONG_PHASE" };
  if (action.by !== state.defender) return { ok: false, reason: "NOT_DEFENDER" };
  if (state.table.length === 0) return { ok: false, reason: "TABLE_EMPTY" };
  const taken = collectTableCards(state.table);
  const prevAttacker = state.attacker;
  const prevDefender = state.defender;
  const newAttacker = (prevDefender + 1) % state.playerCount;
  const newDefender = (newAttacker + 1) % state.playerCount;
  const afterTake: InRoundState = {
    ...state,
    hands: state.hands.map((h, i) => (i === prevDefender ? [...h, ...taken] : h)),
    table: [],
    attacker: newAttacker,
    defender: newDefender,
  };
  return finalizeRoundEnd(afterTake, prevAttacker, prevDefender, [
    {
      type: "PILE_TAKEN",
      by: prevDefender,
      cards: taken,
      attacker: newAttacker,
      defender: newDefender,
    },
  ]);
}

function endRound(state: State, action: { type: "END_ROUND"; by: number }): StepResult {
  if (state.phase !== "in-round") return { ok: false, reason: "WRONG_PHASE" };
  if (action.by !== state.attacker) return { ok: false, reason: "NOT_ATTACKER" };
  if (state.table.length === 0) return { ok: false, reason: "TABLE_EMPTY" };
  if (state.table.some((p) => !p.defense)) return { ok: false, reason: "ATTACKS_UNDEFENDED" };
  const discarded = collectTableCards(state.table);
  const prevAttacker = state.attacker;
  const prevDefender = state.defender;
  const newAttacker = prevDefender;
  const newDefender = (newAttacker + 1) % state.playerCount;
  const afterEnd: InRoundState = {
    ...state,
    table: [],
    discard: [...state.discard, ...discarded],
    attacker: newAttacker,
    defender: newDefender,
  };
  return finalizeRoundEnd(afterEnd, prevAttacker, prevDefender, [
    { type: "ROUND_ENDED", discarded, attacker: newAttacker, defender: newDefender },
  ]);
}

function timeout(state: State, action: { type: "TIMEOUT"; by: number }): StepResult {
  if (state.phase !== "in-round") return { ok: false, reason: "WRONG_PHASE" };
  if (!isValidSeat(state, action.by)) return { ok: false, reason: "INVALID_SEAT" };
  if (action.by === state.defender) {
    return takePile(state, { type: "TAKE_PILE", by: state.defender });
  }
  if (action.by === state.attacker) {
    return endRound(state, { type: "END_ROUND", by: state.attacker });
  }
  return { ok: false, reason: "TIMEOUT_NOT_ACTIVE_SEAT" };
}

function finalizeRoundEnd(
  rotated: InRoundState,
  prevAttacker: number,
  prevDefender: number,
  baseEvents: Event[],
): StepResult {
  const { state: replenished, drawnEvents } = replenish(rotated, prevAttacker, prevDefender);
  const events: Event[] = [...baseEvents, ...drawnEvents];
  const over = detectGameOver(replenished);
  if (over) {
    const final: GameOverState = {
      phase: "game-over",
      playerCount: replenished.playerCount,
      rng: replenished.rng,
      hands: replenished.hands,
      trumpSuit: replenished.trumpSuit,
      trumpCard: replenished.trumpCard,
      discard: replenished.discard,
      durak: over.durak,
    };
    events.push({ type: "GAME_OVER", durak: over.durak });
    return { ok: true, state: final, events };
  }
  return { ok: true, state: replenished, events };
}

function replenish(
  state: InRoundState,
  prevAttacker: number,
  prevDefender: number,
): { state: InRoundState; drawnEvents: Event[] } {
  let talon = state.talon;
  let trumpCard = state.trumpCard;
  const hands = state.hands.map((h) => [...h]);
  const drawnEvents: Event[] = [];
  for (const seat of drawOrder(state.playerCount, prevAttacker, prevDefender)) {
    const hand = hands[seat];
    if (!hand) continue;
    const drawn: Card[] = [];
    while (hand.length < HAND_TARGET && (talon.length > 0 || trumpCard !== null)) {
      let card: Card;
      if (talon.length > 0) {
        card = talon[0] as Card;
        talon = talon.slice(1);
      } else {
        card = trumpCard as Card;
        trumpCard = null;
      }
      hand.push(card);
      drawn.push(card);
    }
    if (drawn.length > 0) {
      drawnEvents.push({ type: "TALON_DRAWN", by: seat, cards: drawn });
    }
  }
  return {
    state: { ...state, hands, talon, trumpCard },
    drawnEvents,
  };
}

function drawOrder(playerCount: number, prevAttacker: number, prevDefender: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < playerCount; i++) {
    const seat = (prevAttacker + i) % playerCount;
    if (seat !== prevDefender) out.push(seat);
  }
  out.push(prevDefender);
  return out;
}

function detectGameOver(state: InRoundState): { durak: number | null } | null {
  if (state.talon.length > 0 || state.trumpCard !== null) return null;
  const withCards: number[] = [];
  for (let i = 0; i < state.playerCount; i++) {
    if ((state.hands[i] as Card[]).length > 0) withCards.push(i);
  }
  if (withCards.length === 0) return { durak: null };
  if (withCards.length === 1) return { durak: withCards[0] as number };
  return null;
}

function collectTableCards(table: readonly TablePair[]): Card[] {
  const out: Card[] = [];
  for (const pair of table) {
    out.push(pair.attack);
    if (pair.defense) out.push(pair.defense);
  }
  return out;
}

export function beats(defense: Card, attack: Card, trump: Suit): boolean {
  if (defense.suit === attack.suit) return defense.rank > attack.rank;
  return defense.suit === trump && attack.suit !== trump;
}

function isValidSeat(state: InRoundState, seat: number): boolean {
  return Number.isInteger(seat) && seat >= 0 && seat < state.playerCount;
}

function handOf(state: InRoundState, seat: number): Card[] {
  const hand = state.hands[seat];
  if (!hand) throw new RangeError(`invalid seat ${seat}`);
  return hand;
}

function findCardIndex(hand: readonly Card[], card: Card): number {
  return hand.findIndex((c) => c.suit === card.suit && c.rank === card.rank);
}

function ranksOnTable(table: readonly TablePair[]): Set<number> {
  const out = new Set<number>();
  for (const p of table) {
    out.add(p.attack.rank);
    if (p.defense) out.add(p.defense.rank);
  }
  return out;
}

function withPlayedAttack(
  state: InRoundState,
  seat: number,
  handIdx: number,
  card: Card,
): InRoundState {
  return {
    ...state,
    hands: state.hands.map((h, i) =>
      i === seat ? [...h.slice(0, handIdx), ...h.slice(handIdx + 1)] : h,
    ),
    table: [...state.table, { attack: card }],
  };
}

function withPlayedDefense(
  state: InRoundState,
  seat: number,
  handIdx: number,
  target: number,
  card: Card,
): InRoundState {
  return {
    ...state,
    hands: state.hands.map((h, i) =>
      i === seat ? [...h.slice(0, handIdx), ...h.slice(handIdx + 1)] : h,
    ),
    table: state.table.map((p, i) => (i === target ? { attack: p.attack, defense: card } : p)),
  };
}
