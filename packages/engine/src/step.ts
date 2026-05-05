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
  | { type: "PASS"; by: number }
  | { type: "TIMEOUT"; by: number };

export type RejectReason =
  | "WRONG_PHASE"
  | "INVALID_SEAT"
  | "NOT_ATTACKER"
  | "NOT_DEFENDER"
  | "DEFENDER_CANNOT_ATTACK"
  | "DEFENDER_CANNOT_PASS"
  | "ELIMINATED_CANNOT_PASS"
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
  | { type: "PLAYER_OUT"; seat: number }
  | { type: "PLAYER_PASSED"; by: number }
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
    case "PASS":
      return pass(state, action);
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
  if (dealt > 36) {
    throw new RangeError("playerCount too large for a 36-card deck");
  }
  const rng = rngFromState(state.rng);
  const shuffled = shuffle(buildDeck(), rng);
  const hands: Card[][] = [];
  for (let p = 0; p < state.playerCount; p++) {
    hands.push(shuffled.slice(p * HAND_TARGET, (p + 1) * HAND_TARGET));
  }
  const remaining = shuffled.slice(dealt);
  let trumpCard: Card | null;
  let trumpSuit: Suit;
  let talon: Card[];
  let trumpForEvent: Card;
  if (remaining.length > 0) {
    trumpCard = remaining[remaining.length - 1] as Card;
    trumpSuit = trumpCard.suit;
    talon = remaining.slice(0, -1);
    trumpForEvent = trumpCard;
  } else {
    // 6-player deal: deck is exactly exhausted (6 * 6 = 36). The last-
    // dealt card serves as the trump indicator — its suit fixes the
    // trump suit but the card itself stays in the last seat's hand, so
    // `trumpCard` is null. The GAME_STARTED event still surfaces the
    // indicator card so consumers can render it face-up.
    const lastCard = shuffled[shuffled.length - 1] as Card;
    trumpSuit = lastCard.suit;
    trumpCard = null;
    talon = [];
    trumpForEvent = lastCard;
  }
  const attacker = pickAttacker(hands, trumpSuit);
  const defender = (attacker + 1) % state.playerCount;
  const next: InRoundState = {
    phase: "in-round",
    playerCount: state.playerCount,
    rng: rng.state,
    hands,
    talon,
    trumpSuit,
    trumpCard,
    table: [],
    attacker,
    defender,
    discard: [],
  };
  return {
    ok: true,
    state: next,
    events: [{ type: "GAME_STARTED", trump: trumpForEvent, attacker }],
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
  const events: Event[] = [
    { type: "CARD_PLAYED", by: action.by, role: "ATTACK", card: action.card },
    ...newlyOutEvents(state, next),
  ];
  return { ok: true, state: next, events };
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
  const events: Event[] = [
    { type: "CARD_PLAYED", by: action.by, role: "THROW_IN", card: action.card },
    ...newlyOutEvents(state, next),
  ];
  return { ok: true, state: next, events };
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
  const events: Event[] = [
    {
      type: "CARD_PLAYED",
      by: action.by,
      role: "DEFEND",
      card: action.card,
      target: action.target,
    },
    ...newlyOutEvents(state, next),
  ];
  return { ok: true, state: next, events };
}

function takePile(state: State, action: { type: "TAKE_PILE"; by: number }): StepResult {
  if (state.phase !== "in-round") return { ok: false, reason: "WRONG_PHASE" };
  if (action.by !== state.defender) return { ok: false, reason: "NOT_DEFENDER" };
  if (state.table.length === 0) return { ok: false, reason: "TABLE_EMPTY" };
  const taken = collectTableCards(state.table);
  const prevAttacker = state.attacker;
  const prevDefender = state.defender;
  const eliminatedBefore = eliminatedSeatsOf(state);
  const afterTake: InRoundState = {
    ...state,
    hands: state.hands.map((h, i) => (i === prevDefender ? [...h, ...taken] : h)),
    table: [],
  };
  return finalizeRoundEnd(afterTake, prevAttacker, prevDefender, eliminatedBefore, {
    type: "TAKE_PILE",
    cards: taken,
  });
}

function endRound(state: State, action: { type: "END_ROUND"; by: number }): StepResult {
  if (state.phase !== "in-round") return { ok: false, reason: "WRONG_PHASE" };
  if (action.by !== state.attacker) return { ok: false, reason: "NOT_ATTACKER" };
  if (state.table.length === 0) return { ok: false, reason: "TABLE_EMPTY" };
  if (state.table.some((p) => !p.defense)) return { ok: false, reason: "ATTACKS_UNDEFENDED" };
  const discarded = collectTableCards(state.table);
  const prevAttacker = state.attacker;
  const prevDefender = state.defender;
  const eliminatedBefore = eliminatedSeatsOf(state);
  const afterEnd: InRoundState = {
    ...state,
    table: [],
    discard: [...state.discard, ...discarded],
  };
  return finalizeRoundEnd(afterEnd, prevAttacker, prevDefender, eliminatedBefore, {
    type: "END_ROUND",
    discarded,
  });
}

function pass(state: State, action: { type: "PASS"; by: number }): StepResult {
  if (state.phase !== "in-round") return { ok: false, reason: "WRONG_PHASE" };
  if (!isValidSeat(state, action.by)) return { ok: false, reason: "INVALID_SEAT" };
  if (action.by === state.defender) return { ok: false, reason: "DEFENDER_CANNOT_PASS" };
  if (eliminatedSeatsOf(state).has(action.by)) {
    return { ok: false, reason: "ELIMINATED_CANNOT_PASS" };
  }
  return { ok: true, state, events: [{ type: "PLAYER_PASSED", by: action.by }] };
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

type FinalizeKind = { type: "TAKE_PILE"; cards: Card[] } | { type: "END_ROUND"; discarded: Card[] };

function finalizeRoundEnd(
  cleared: InRoundState,
  prevAttacker: number,
  prevDefender: number,
  eliminatedBefore: ReadonlySet<number>,
  kind: FinalizeKind,
): StepResult {
  const { state: replenished, drawnEvents } = replenish(cleared, prevAttacker, prevDefender);
  const eliminatedNow = eliminatedSeatsOf(replenished);
  const newlyOut: number[] = [];
  for (let seat = 0; seat < replenished.playerCount; seat++) {
    if (eliminatedNow.has(seat) && !eliminatedBefore.has(seat)) {
      newlyOut.push(seat);
    }
  }
  const playerOutEvents: Event[] = newlyOut.map((seat) => ({ type: "PLAYER_OUT", seat }));

  const over = detectGameOver(replenished);
  const rotation = rotateRoles(replenished.playerCount, prevDefender, eliminatedNow, kind.type);

  const baseEvent: Event =
    kind.type === "TAKE_PILE"
      ? {
          type: "PILE_TAKEN",
          by: prevDefender,
          cards: kind.cards,
          attacker: rotation.attacker,
          defender: rotation.defender,
        }
      : {
          type: "ROUND_ENDED",
          discarded: kind.discarded,
          attacker: rotation.attacker,
          defender: rotation.defender,
        };

  const events: Event[] = [baseEvent, ...drawnEvents, ...playerOutEvents];
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
  const next: InRoundState = {
    ...replenished,
    attacker: rotation.attacker,
    defender: rotation.defender,
  };
  return { ok: true, state: next, events };
}

function rotateRoles(
  playerCount: number,
  prevDefender: number,
  eliminated: ReadonlySet<number>,
  kind: "TAKE_PILE" | "END_ROUND",
): { attacker: number; defender: number } {
  // END_ROUND: prev defender becomes new attacker (Podkidnoy: a successful
  // defender attacks left). TAKE_PILE: prev defender is skipped, the next
  // active seat after them attacks.
  const includeStart = kind === "END_ROUND";
  const activeAttacker = firstActiveSeatFrom(playerCount, prevDefender, eliminated, includeStart);
  if (activeAttacker < 0) {
    // No active seats remain (every seat eliminated). Falls back to naive
    // rotation; values are emitted on the terminal event but the state
    // transitions to game-over so they are not used for further play.
    const naiveAttacker = kind === "TAKE_PILE" ? (prevDefender + 1) % playerCount : prevDefender;
    return { attacker: naiveAttacker, defender: (naiveAttacker + 1) % playerCount };
  }
  const activeDefender = firstActiveSeatFrom(playerCount, activeAttacker, eliminated, false);
  if (activeDefender < 0 || activeDefender === activeAttacker) {
    // Exactly one active seat (the durak); game-over fires this transition.
    return { attacker: activeAttacker, defender: (activeAttacker + 1) % playerCount };
  }
  return { attacker: activeAttacker, defender: activeDefender };
}

function firstActiveSeatFrom(
  playerCount: number,
  start: number,
  eliminated: ReadonlySet<number>,
  includeStart: boolean,
): number {
  const offset = includeStart ? 0 : 1;
  for (let i = offset; i < playerCount; i++) {
    const seat = (start + i) % playerCount;
    if (!eliminated.has(seat)) return seat;
  }
  return -1;
}

function newlyOutEvents(
  pre: { hands: readonly (readonly Card[])[]; talon: readonly Card[]; trumpCard: Card | null },
  post: { hands: readonly (readonly Card[])[]; talon: readonly Card[]; trumpCard: Card | null },
): Event[] {
  const before = eliminatedSeatsOf(pre);
  const after = eliminatedSeatsOf(post);
  const out: Event[] = [];
  for (const seat of after) {
    if (!before.has(seat)) out.push({ type: "PLAYER_OUT", seat });
  }
  return out;
}

function eliminatedSeatsOf(s: {
  hands: readonly (readonly Card[])[];
  talon: readonly Card[];
  trumpCard: Card | null;
}): Set<number> {
  if (s.talon.length > 0 || s.trumpCard !== null) return new Set();
  const out = new Set<number>();
  for (let i = 0; i < s.hands.length; i++) {
    if ((s.hands[i] as readonly Card[]).length === 0) out.add(i);
  }
  return out;
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
