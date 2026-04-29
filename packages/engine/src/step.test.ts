import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Card, Suit } from "./cards";
import { createRng } from "./rng";
import {
  type GameOverState,
  type InRoundState,
  initialState,
  type State,
  type TablePair,
} from "./state";
import { type Action, beats, type Event, type StepResult, step } from "./step";

const cardKey = (c: Card) => `${c.suit}-${c.rank}`;

function expectOk(result: StepResult): { state: InRoundState; events: Event[] } {
  if (!result.ok) throw new Error(`step rejected: ${result.reason}`);
  if (result.state.phase !== "in-round") {
    throw new Error("expected in-round phase");
  }
  return { state: result.state, events: result.events };
}

function deal(seed: number, playerCount = 2): InRoundState {
  return expectOk(step(initialState({ seed, playerCount }), { type: "START_GAME" })).state;
}

function mkInRound(opts: {
  trump: Card;
  hands: Card[][];
  table?: TablePair[];
  talon?: Card[];
  attacker?: number;
  defender?: number;
  trumpCard?: Card | null;
}): InRoundState {
  const playerCount = opts.hands.length;
  const attacker = opts.attacker ?? 0;
  return {
    phase: "in-round",
    playerCount,
    rng: createRng(0).state,
    hands: opts.hands.map((h) => [...h]),
    talon: opts.talon ?? [],
    trumpSuit: opts.trump.suit,
    trumpCard: opts.trumpCard === undefined ? opts.trump : opts.trumpCard,
    table: (opts.table ?? []).map((p) => ({ ...p })),
    attacker,
    defender: opts.defender ?? (attacker + 1) % playerCount,
    discard: [],
  };
}

const card = (suit: Suit, rank: number): Card => ({ suit, rank: rank as Card["rank"] });

describe("step START_GAME", () => {
  it("deals 6 cards to each player", () => {
    const s = deal(2026, 2);
    expect(s.hands).toHaveLength(2);
    for (const hand of s.hands) {
      expect(hand).toHaveLength(6);
    }
  });

  it("sets the trump card and leaves talon size 36 - 6*N - 1", () => {
    const s = deal(2026, 2);
    expect(s.trumpCard).not.toBeNull();
    expect(s.trumpSuit).toBe(s.trumpCard?.suit);
    expect(s.talon).toHaveLength(36 - 6 * 2 - 1);
  });

  it("starts with empty table and discard", () => {
    const s = deal(2026, 2);
    expect(s.table).toEqual([]);
    expect(s.discard).toEqual([]);
  });

  it("picks the player with the lowest trump as attacker", () => {
    const s = deal(2026, 2);
    const trumps = s.hands.map((hand) =>
      hand.filter((c) => c.suit === s.trumpSuit).map((c) => c.rank),
    );
    const lowestPerHand = trumps.map((ranks) =>
      ranks.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...ranks),
    );
    const minRank = Math.min(...lowestPerHand);
    if (Number.isFinite(minRank)) {
      expect(lowestPerHand[s.attacker]).toBe(minRank);
    } else {
      expect(s.attacker).toBe(0);
    }
    expect(s.defender).toBe((s.attacker + 1) % s.playerCount);
  });

  it("emits a GAME_STARTED event with trump and attacker", () => {
    const init = initialState({ seed: 5, playerCount: 2 });
    const { state, events } = expectOk(step(init, { type: "START_GAME" }));
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "GAME_STARTED",
      trump: state.trumpCard,
      attacker: state.attacker,
    });
  });

  it("advances the rng snapshot during the deal", () => {
    const init = initialState({ seed: 9 });
    const { state } = expectOk(step(init, { type: "START_GAME" }));
    expect(state.rng).not.toEqual(init.rng);
  });

  it("rejects START_GAME from a non-pre-deal phase", () => {
    const init = initialState({ seed: 1 });
    const { state } = expectOk(step(init, { type: "START_GAME" }));
    expect(() => step(state, { type: "START_GAME" })).toThrow();
  });

  it("rejects player counts that exceed deck capacity", () => {
    expect(() => deal(1, 6)).toThrow(RangeError);
  });

  it("produces a JSON-serializable state", () => {
    const s = deal(2026, 2);
    const round = JSON.parse(JSON.stringify(s));
    expect(round).toEqual(s);
  });

  it("conserves all 36 cards across hands, talon, and trump (property)", () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const s = deal(seed, 2);
        if (!s.trumpCard) throw new Error("expected trumpCard after deal");
        const all = [...s.hands.flat(), ...s.talon, s.trumpCard];
        expect(all).toHaveLength(36);
        expect(new Set(all.map(cardKey)).size).toBe(36);
      }),
      { numRuns: 100 },
    );
  });

  it("is deterministic for the same seed (property)", () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const a = deal(seed, 2);
        const b = deal(seed, 2);
        expect(a).toEqual(b);
      }),
      { numRuns: 100 },
    );
  });
});

describe("beats (Russian rules)", () => {
  const trump: Suit = "hearts";
  const cases: Array<{
    name: string;
    defense: Card;
    attack: Card;
    expected: boolean;
  }> = [
    {
      name: "higher rank, same non-trump suit beats",
      defense: card("spades", 10),
      attack: card("spades", 7),
      expected: true,
    },
    {
      name: "lower rank, same non-trump suit does not beat",
      defense: card("spades", 7),
      attack: card("spades", 10),
      expected: false,
    },
    {
      name: "higher rank, same trump suit beats",
      defense: card("hearts", 12),
      attack: card("hearts", 8),
      expected: true,
    },
    {
      name: "lower rank, same trump suit does not beat",
      defense: card("hearts", 8),
      attack: card("hearts", 12),
      expected: false,
    },
    {
      name: "trump beats non-trump regardless of rank",
      defense: card("hearts", 6),
      attack: card("spades", 14),
      expected: true,
    },
    {
      name: "non-trump cannot beat trump",
      defense: card("spades", 14),
      attack: card("hearts", 6),
      expected: false,
    },
    {
      name: "different non-trump suits never beat",
      defense: card("spades", 14),
      attack: card("clubs", 6),
      expected: false,
    },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(beats(c.defense, c.attack, trump)).toBe(c.expected);
    });
  }
});

describe("step ATTACK", () => {
  const trump = card("hearts", 11);
  const base = (overrides: Partial<Parameters<typeof mkInRound>[0]> = {}) =>
    mkInRound({
      trump,
      hands: [
        [card("spades", 7), card("clubs", 9)],
        [card("diamonds", 8), card("hearts", 6)],
      ],
      ...overrides,
    });

  it("places the card on the table and removes it from the attacker's hand", () => {
    const state = base();
    const { state: next, events } = expectOk(
      step(state, { type: "ATTACK", by: 0, card: card("spades", 7) }),
    );
    expect(next.table).toEqual([{ attack: card("spades", 7) }]);
    expect(next.hands[0]).toEqual([card("clubs", 9)]);
    expect(next.hands[1]).toEqual(state.hands[1]);
    expect(events).toEqual([
      { type: "CARD_PLAYED", by: 0, role: "ATTACK", card: card("spades", 7) },
    ]);
  });

  it("rejects when not the attacker's turn", () => {
    const r = step(base(), { type: "ATTACK", by: 1, card: card("diamonds", 8) });
    expect(r).toEqual({ ok: false, reason: "NOT_ATTACKER" });
  });

  it("rejects when the card is not in the attacker's hand", () => {
    const r = step(base(), { type: "ATTACK", by: 0, card: card("spades", 14) });
    expect(r).toEqual({ ok: false, reason: "CARD_NOT_IN_HAND" });
  });

  it("rejects when the table is not empty (use THROW_IN instead)", () => {
    const state = base({ table: [{ attack: card("clubs", 6) }] });
    const r = step(state, { type: "ATTACK", by: 0, card: card("spades", 7) });
    expect(r).toEqual({ ok: false, reason: "TABLE_NOT_EMPTY" });
  });

  it("rejects when the defender has no cards left", () => {
    const state = mkInRound({
      trump,
      hands: [[card("spades", 7)], []],
    });
    const r = step(state, { type: "ATTACK", by: 0, card: card("spades", 7) });
    expect(r).toEqual({ ok: false, reason: "DEFENDER_OVERWHELMED" });
  });

  it("rejects when phase is not in-round", () => {
    const r = step(initialState({ seed: 1 }), {
      type: "ATTACK",
      by: 0,
      card: card("spades", 7),
    });
    expect(r).toEqual({ ok: false, reason: "WRONG_PHASE" });
  });
});

describe("step DEFEND", () => {
  const trump = card("hearts", 11);

  it("pairs the defense onto the targeted attack and removes the card from hand", () => {
    const state = mkInRound({
      trump,
      hands: [[card("spades", 7)], [card("spades", 10)]],
      table: [{ attack: card("spades", 8) }],
    });
    const { state: next, events } = expectOk(
      step(state, { type: "DEFEND", by: 1, card: card("spades", 10), target: 0 }),
    );
    expect(next.table).toEqual([{ attack: card("spades", 8), defense: card("spades", 10) }]);
    expect(next.hands[1]).toEqual([]);
    expect(events).toEqual([
      {
        type: "CARD_PLAYED",
        by: 1,
        role: "DEFEND",
        card: card("spades", 10),
        target: 0,
      },
    ]);
  });

  it("rejects when the defender plays a card that does not beat the attack", () => {
    const state = mkInRound({
      trump,
      hands: [[card("spades", 7)], [card("spades", 6), card("clubs", 14)]],
      table: [{ attack: card("spades", 10) }],
    });
    expect(step(state, { type: "DEFEND", by: 1, card: card("spades", 6), target: 0 })).toEqual({
      ok: false,
      reason: "DOES_NOT_BEAT",
    });
    expect(step(state, { type: "DEFEND", by: 1, card: card("clubs", 14), target: 0 })).toEqual({
      ok: false,
      reason: "DOES_NOT_BEAT",
    });
  });

  it("accepts a trump played onto a non-trump attack", () => {
    const state = mkInRound({
      trump,
      hands: [[card("spades", 7)], [card("hearts", 6)]],
      table: [{ attack: card("spades", 14) }],
    });
    expectOk(step(state, { type: "DEFEND", by: 1, card: card("hearts", 6), target: 0 }));
  });

  it("rejects a non-defender", () => {
    const state = mkInRound({
      trump,
      hands: [[card("spades", 7)], [card("spades", 10)]],
      table: [{ attack: card("spades", 8) }],
    });
    expect(step(state, { type: "DEFEND", by: 0, card: card("spades", 10), target: 0 })).toEqual({
      ok: false,
      reason: "NOT_DEFENDER",
    });
  });

  it("rejects an invalid target", () => {
    const state = mkInRound({
      trump,
      hands: [[card("spades", 7)], [card("spades", 10)]],
      table: [{ attack: card("spades", 8) }],
    });
    expect(step(state, { type: "DEFEND", by: 1, card: card("spades", 10), target: 1 })).toEqual({
      ok: false,
      reason: "INVALID_TARGET",
    });
  });

  it("rejects defending a slot that is already defended", () => {
    const state = mkInRound({
      trump,
      hands: [[card("spades", 7)], [card("spades", 10), card("spades", 11)]],
      table: [{ attack: card("spades", 8), defense: card("spades", 9) }],
    });
    expect(step(state, { type: "DEFEND", by: 1, card: card("spades", 10), target: 0 })).toEqual({
      ok: false,
      reason: "TARGET_ALREADY_DEFENDED",
    });
  });

  it("rejects when the defense card is not in the defender's hand", () => {
    const state = mkInRound({
      trump,
      hands: [[card("spades", 7)], [card("spades", 10)]],
      table: [{ attack: card("spades", 8) }],
    });
    expect(step(state, { type: "DEFEND", by: 1, card: card("spades", 11), target: 0 })).toEqual({
      ok: false,
      reason: "CARD_NOT_IN_HAND",
    });
  });
});

describe("step THROW_IN", () => {
  const trump = card("hearts", 11);

  it("adds an extra attack matching a rank already on the table", () => {
    const state = mkInRound({
      trump,
      hands: [
        [card("clubs", 8), card("diamonds", 13)],
        [card("spades", 14), card("hearts", 10)],
      ],
      table: [{ attack: card("spades", 8), defense: card("spades", 9) }],
    });
    const { state: next, events } = expectOk(
      step(state, { type: "THROW_IN", by: 0, card: card("clubs", 8) }),
    );
    expect(next.table).toEqual([
      { attack: card("spades", 8), defense: card("spades", 9) },
      { attack: card("clubs", 8) },
    ]);
    expect(next.hands[0]).toEqual([card("diamonds", 13)]);
    expect(events).toEqual([
      { type: "CARD_PLAYED", by: 0, role: "THROW_IN", card: card("clubs", 8) },
    ]);
  });

  it("matches against defense ranks too", () => {
    const state = mkInRound({
      trump,
      hands: [[card("clubs", 9)], [card("hearts", 14)]],
      table: [{ attack: card("spades", 8), defense: card("spades", 9) }],
    });
    expectOk(step(state, { type: "THROW_IN", by: 0, card: card("clubs", 9) }));
  });

  it("rejects when no card on the table matches the rank", () => {
    const state = mkInRound({
      trump,
      hands: [[card("clubs", 12)], [card("hearts", 14)]],
      table: [{ attack: card("spades", 8) }],
    });
    expect(step(state, { type: "THROW_IN", by: 0, card: card("clubs", 12) })).toEqual({
      ok: false,
      reason: "RANK_NOT_ON_TABLE",
    });
  });

  it("rejects when the table is empty (use ATTACK instead)", () => {
    const state = mkInRound({
      trump,
      hands: [[card("clubs", 8)], [card("hearts", 14)]],
    });
    expect(step(state, { type: "THROW_IN", by: 0, card: card("clubs", 8) })).toEqual({
      ok: false,
      reason: "TABLE_EMPTY",
    });
  });

  it("rejects the defender from throwing in", () => {
    const state = mkInRound({
      trump,
      hands: [[card("clubs", 8)], [card("clubs", 9), card("hearts", 14)]],
      table: [{ attack: card("spades", 9) }],
    });
    expect(step(state, { type: "THROW_IN", by: 1, card: card("clubs", 9) })).toEqual({
      ok: false,
      reason: "DEFENDER_CANNOT_ATTACK",
    });
  });

  it("rejects an out-of-range seat", () => {
    const state = mkInRound({
      trump,
      hands: [[card("clubs", 8)], [card("hearts", 14)]],
      table: [{ attack: card("spades", 8) }],
    });
    expect(step(state, { type: "THROW_IN", by: 5, card: card("clubs", 8) })).toEqual({
      ok: false,
      reason: "INVALID_SEAT",
    });
  });

  it("rejects when adding would exceed the 6-attack bout cap", () => {
    const ranks = [6, 7, 8, 9, 10, 11];
    const table: TablePair[] = ranks.map((r) => ({
      attack: card("spades", r),
      defense: card("hearts", r),
    }));
    const state = mkInRound({
      trump,
      hands: [[card("clubs", 6)], [card("diamonds", 14)]],
      table,
    });
    expect(step(state, { type: "THROW_IN", by: 0, card: card("clubs", 6) })).toEqual({
      ok: false,
      reason: "ATTACK_LIMIT_REACHED",
    });
  });

  it("rejects when the defender cannot cover one more undefended attack", () => {
    const state = mkInRound({
      trump,
      hands: [[card("clubs", 8), card("diamonds", 8)], [card("hearts", 14)]],
      table: [{ attack: card("spades", 8) }],
    });
    expect(step(state, { type: "THROW_IN", by: 0, card: card("clubs", 8) })).toEqual({
      ok: false,
      reason: "DEFENDER_OVERWHELMED",
    });
  });

  it("rejects a card that is not in the player's hand", () => {
    const state = mkInRound({
      trump,
      hands: [[card("clubs", 9)], [card("hearts", 14)]],
      table: [{ attack: card("spades", 8) }],
    });
    expect(step(state, { type: "THROW_IN", by: 0, card: card("clubs", 8) })).toEqual({
      ok: false,
      reason: "CARD_NOT_IN_HAND",
    });
  });
});

describe("step TAKE_PILE", () => {
  const trump = card("hearts", 11);

  it("moves the table cards into the defender's hand and clears the table", () => {
    const state = mkInRound({
      trump,
      trumpCard: null,
      hands: [[card("clubs", 6), card("clubs", 7)], [card("diamonds", 9)]],
      table: [
        { attack: card("spades", 7), defense: card("spades", 8) },
        { attack: card("clubs", 10) },
      ],
    });
    const { state: next, events } = expectOk(step(state, { type: "TAKE_PILE", by: 1 }));
    expect(next.table).toEqual([]);
    expect(next.hands[1]).toEqual([
      card("diamonds", 9),
      card("spades", 7),
      card("spades", 8),
      card("clubs", 10),
    ]);
    expect(next.discard).toEqual([]);
    expect(events).toEqual([
      {
        type: "PILE_TAKEN",
        by: 1,
        cards: [card("spades", 7), card("spades", 8), card("clubs", 10)],
        attacker: 0,
        defender: 1,
      },
    ]);
  });

  it("rotates roles so the defender is skipped (next attacker is past the defender)", () => {
    const state = mkInRound({
      trump,
      hands: [[card("clubs", 6)], [card("diamonds", 9)], [card("hearts", 14)]],
      table: [{ attack: card("spades", 8) }],
      attacker: 0,
      defender: 1,
    });
    const { state: next } = expectOk(step(state, { type: "TAKE_PILE", by: 1 }));
    expect(next.attacker).toBe(2);
    expect(next.defender).toBe(0);
  });

  it("rotates back to the same attacker in 1v1", () => {
    const state = mkInRound({
      trump,
      hands: [[card("clubs", 6)], [card("diamonds", 9)]],
      table: [{ attack: card("spades", 8) }],
      attacker: 0,
      defender: 1,
    });
    const { state: next } = expectOk(step(state, { type: "TAKE_PILE", by: 1 }));
    expect(next.attacker).toBe(0);
    expect(next.defender).toBe(1);
  });

  it("rejects a non-defender", () => {
    const state = mkInRound({
      trump,
      hands: [[card("clubs", 6)], [card("diamonds", 9)]],
      table: [{ attack: card("spades", 8) }],
    });
    expect(step(state, { type: "TAKE_PILE", by: 0 })).toEqual({
      ok: false,
      reason: "NOT_DEFENDER",
    });
  });

  it("rejects when the table is empty", () => {
    const state = mkInRound({
      trump,
      hands: [[card("clubs", 6)], [card("diamonds", 9)]],
    });
    expect(step(state, { type: "TAKE_PILE", by: 1 })).toEqual({
      ok: false,
      reason: "TABLE_EMPTY",
    });
  });

  it("rejects when phase is not in-round", () => {
    expect(step(initialState({ seed: 1 }), { type: "TAKE_PILE", by: 1 })).toEqual({
      ok: false,
      reason: "WRONG_PHASE",
    });
  });
});

describe("step END_ROUND", () => {
  const trump = card("hearts", 11);

  it("moves the table cards into discard and rotates roles one seat", () => {
    const state = mkInRound({
      trump,
      trumpCard: null,
      hands: [[card("clubs", 6)], [card("diamonds", 9)]],
      table: [
        { attack: card("spades", 7), defense: card("spades", 8) },
        { attack: card("clubs", 10), defense: card("clubs", 12) },
      ],
      attacker: 0,
      defender: 1,
    });
    const { state: next, events } = expectOk(step(state, { type: "END_ROUND", by: 0 }));
    expect(next.table).toEqual([]);
    expect(next.discard).toEqual([
      card("spades", 7),
      card("spades", 8),
      card("clubs", 10),
      card("clubs", 12),
    ]);
    expect(next.attacker).toBe(1);
    expect(next.defender).toBe(0);
    expect(events).toEqual([
      {
        type: "ROUND_ENDED",
        discarded: [card("spades", 7), card("spades", 8), card("clubs", 10), card("clubs", 12)],
        attacker: 1,
        defender: 0,
      },
    ]);
  });

  it("rejects when any attack is still undefended", () => {
    const state = mkInRound({
      trump,
      hands: [[card("clubs", 6)], [card("diamonds", 9)]],
      table: [
        { attack: card("spades", 7), defense: card("spades", 8) },
        { attack: card("clubs", 10) },
      ],
    });
    expect(step(state, { type: "END_ROUND", by: 0 })).toEqual({
      ok: false,
      reason: "ATTACKS_UNDEFENDED",
    });
  });

  it("rejects a non-attacker", () => {
    const state = mkInRound({
      trump,
      hands: [[card("clubs", 6)], [card("diamonds", 9)]],
      table: [{ attack: card("spades", 7), defense: card("spades", 8) }],
    });
    expect(step(state, { type: "END_ROUND", by: 1 })).toEqual({
      ok: false,
      reason: "NOT_ATTACKER",
    });
  });

  it("rejects when the table is empty", () => {
    const state = mkInRound({
      trump,
      hands: [[card("clubs", 6)], [card("diamonds", 9)]],
    });
    expect(step(state, { type: "END_ROUND", by: 0 })).toEqual({
      ok: false,
      reason: "TABLE_EMPTY",
    });
  });

  it("rejects when phase is not in-round", () => {
    expect(step(initialState({ seed: 1 }), { type: "END_ROUND", by: 0 })).toEqual({
      ok: false,
      reason: "WRONG_PHASE",
    });
  });
});

describe("step exhaustiveness", () => {
  it("throws on an unknown action variant", () => {
    const s = deal(1, 2);
    expect(() => step(s, { type: "UNKNOWN" } as unknown as Action)).toThrow();
  });
});

function totalCards(s: InRoundState | GameOverState): number {
  let defenseCount = 0;
  const tableLength = s.phase === "in-round" ? s.table.length : 0;
  if (s.phase === "in-round") {
    for (const p of s.table) if (p.defense) defenseCount++;
  }
  const talonLength = s.phase === "in-round" ? s.talon.length : 0;
  return (
    s.hands.flat().length +
    tableLength +
    defenseCount +
    talonLength +
    (s.trumpCard ? 1 : 0) +
    s.discard.length
  );
}

function uniqueCardCount(s: InRoundState | GameOverState): number {
  const keys = new Set<string>();
  for (const card of s.hands.flat()) keys.add(cardKey(card));
  if (s.phase === "in-round") {
    for (const p of s.table) {
      keys.add(cardKey(p.attack));
      if (p.defense) keys.add(cardKey(p.defense));
    }
    for (const card of s.talon) keys.add(cardKey(card));
  }
  for (const card of s.discard) keys.add(cardKey(card));
  if (s.trumpCard) keys.add(cardKey(s.trumpCard));
  return keys.size;
}

function pickLegalAction(s: InRoundState, choice: number, trumpSuit: Suit): Action | null {
  const attackerHand = s.hands[s.attacker] as Card[];
  const defenderHand = s.hands[s.defender] as Card[];
  const undefendedCount = s.table.reduce((n, p) => (p.defense ? n : n + 1), 0);

  const tryDefend = (): Action | null => {
    const undefendedIdx = s.table.findIndex((p) => !p.defense);
    if (undefendedIdx < 0) return null;
    const target = s.table[undefendedIdx] as TablePair;
    const defenders = defenderHand.filter((c) => beats(c, target.attack, trumpSuit));
    if (defenders.length === 0) return null;
    const card = defenders[choice % defenders.length] as Card;
    return { type: "DEFEND", by: s.defender, card, target: undefendedIdx };
  };

  if (s.table.length > 0 && undefendedCount > 0 && choice % 11 === 0) {
    return { type: "TAKE_PILE", by: s.defender };
  }

  if (s.table.length > 0 && undefendedCount === 0 && choice % 7 === 0) {
    return { type: "END_ROUND", by: s.attacker };
  }

  if (choice % 3 === 0) {
    const action = tryDefend();
    if (action) return action;
  }

  if (s.table.length === 0) {
    if (attackerHand.length === 0 || defenderHand.length === 0) return null;
    const card = attackerHand[choice % attackerHand.length] as Card;
    return { type: "ATTACK", by: s.attacker, card };
  }

  if (s.table.length < 6) {
    if (undefendedCount + 1 <= defenderHand.length) {
      const ranks = new Set<number>();
      for (const p of s.table) {
        ranks.add(p.attack.rank);
        if (p.defense) ranks.add(p.defense.rank);
      }
      const candidates = attackerHand.filter((c) => ranks.has(c.rank));
      if (candidates.length > 0) {
        const card = candidates[choice % candidates.length] as Card;
        return { type: "THROW_IN", by: s.attacker, card };
      }
    }
  }

  const defend = tryDefend();
  if (defend) return defend;

  if (undefendedCount > 0) return { type: "TAKE_PILE", by: s.defender };
  if (s.table.length > 0) return { type: "END_ROUND", by: s.attacker };
  return null;
}

describe("step invariants under random legal play (property)", () => {
  it("preserves the 36-card total and uniqueness across rounds", () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.array(fc.nat(), { minLength: 1, maxLength: 200 }),
        (seed, choices) => {
          let s: State = deal(seed, 2);
          if (s.phase !== "in-round") return;
          expect(totalCards(s)).toBe(36);
          expect(uniqueCardCount(s)).toBe(36);

          for (const choice of choices) {
            if (s.phase !== "in-round") break;
            const action = pickLegalAction(s, choice, s.trumpSuit);
            if (!action) break;
            const r = step(s, action);
            if (!r.ok) {
              throw new Error(`unexpected rejection: ${r.reason}`);
            }
            s = r.state;
            if (s.phase !== "in-round") break;
            expect(totalCards(s)).toBe(36);
            expect(uniqueCardCount(s)).toBe(36);
          }
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("every successful DEFEND yields a card that beats the attack (property)", () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.array(fc.nat(), { minLength: 1, maxLength: 30 }),
        (seed, choices) => {
          let s: State = deal(seed, 2);
          if (s.phase !== "in-round") return;
          for (const choice of choices) {
            if (s.phase !== "in-round") break;
            const action = pickLegalAction(s, choice, s.trumpSuit);
            if (!action) break;
            const r = step(s, action);
            if (!r.ok) throw new Error(`rejection: ${r.reason}`);
            s = r.state;
            if (s.phase !== "in-round") break;
            for (const p of s.table) {
              if (p.defense) {
                expect(beats(p.defense, p.attack, s.trumpSuit)).toBe(true);
              }
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("triggers TAKE_PILE and END_ROUND across the run space (sanity)", () => {
    let seenTakePile = false;
    let seenEndRound = false;
    for (let seed = 1; seed <= 200 && !(seenTakePile && seenEndRound); seed++) {
      let s: State = deal(seed, 2);
      if (s.phase !== "in-round") continue;
      for (let i = 0; i < 200; i++) {
        if (s.phase !== "in-round") break;
        const action = pickLegalAction(s, seed * 31 + i, s.trumpSuit);
        if (!action) break;
        if (action.type === "TAKE_PILE") seenTakePile = true;
        if (action.type === "END_ROUND") seenEndRound = true;
        const r = step(s, action);
        if (!r.ok) throw new Error(`rejection: ${r.reason}`);
        s = r.state;
      }
    }
    expect(seenTakePile).toBe(true);
    expect(seenEndRound).toBe(true);
  });
});

describe("step golden trace (multi-round play through TAKE_PILE and END_ROUND)", () => {
  it("matches a recorded event sequence for a fixed seed", () => {
    const trump = card("hearts", 11);
    const start = mkInRound({
      trump,
      trumpCard: null,
      hands: [
        [card("spades", 7), card("spades", 9), card("clubs", 8)],
        [card("spades", 8), card("diamonds", 14), card("clubs", 13)],
      ],
      attacker: 0,
      defender: 1,
      talon: [],
    });

    const trace: { action: Action; events: Event[] }[] = [];
    let s: InRoundState = start;

    const apply = (action: Action) => {
      const r = step(s, action);
      if (!r.ok) throw new Error(`rejection: ${r.reason}`);
      if (r.state.phase !== "in-round") throw new Error("game ended unexpectedly");
      s = r.state;
      trace.push({ action, events: r.events });
    };

    apply({ type: "ATTACK", by: 0, card: card("spades", 7) });
    apply({ type: "DEFEND", by: 1, card: card("spades", 8), target: 0 });
    apply({ type: "END_ROUND", by: 0 });

    expect(s.discard).toEqual([card("spades", 7), card("spades", 8)]);
    expect(s.attacker).toBe(1);
    expect(s.defender).toBe(0);

    apply({ type: "ATTACK", by: 1, card: card("clubs", 13) });
    apply({ type: "TAKE_PILE", by: 0 });

    expect(s.attacker).toBe(1);
    expect(s.defender).toBe(0);
    expect(s.hands[0]).toEqual([card("spades", 9), card("clubs", 8), card("clubs", 13)]);
    expect(s.discard).toEqual([card("spades", 7), card("spades", 8)]);

    expect(trace.map((t) => t.events)).toEqual([
      [{ type: "CARD_PLAYED", by: 0, role: "ATTACK", card: card("spades", 7) }],
      [
        {
          type: "CARD_PLAYED",
          by: 1,
          role: "DEFEND",
          card: card("spades", 8),
          target: 0,
        },
      ],
      [
        {
          type: "ROUND_ENDED",
          discarded: [card("spades", 7), card("spades", 8)],
          attacker: 1,
          defender: 0,
        },
      ],
      [{ type: "CARD_PLAYED", by: 1, role: "ATTACK", card: card("clubs", 13) }],
      [
        {
          type: "PILE_TAKEN",
          by: 0,
          cards: [card("clubs", 13)],
          attacker: 1,
          defender: 0,
        },
      ],
    ]);
  });
});

describe("step talon replenishment", () => {
  const trump = card("hearts", 11);

  it("draws attacker first, defender last (Podkidnoy 1v1)", () => {
    const state = mkInRound({
      trump,
      talon: [
        card("spades", 6),
        card("spades", 9),
        card("spades", 10),
        card("clubs", 7),
        card("clubs", 11),
        card("diamonds", 6),
      ],
      hands: [[card("clubs", 6)], [card("diamonds", 7)]],
      table: [{ attack: card("spades", 7), defense: card("spades", 8) }],
      attacker: 0,
      defender: 1,
    });
    const { state: next, events } = expectOk(step(state, { type: "END_ROUND", by: 0 }));
    expect(next.hands[0]).toEqual([
      card("clubs", 6),
      card("spades", 6),
      card("spades", 9),
      card("spades", 10),
      card("clubs", 7),
      card("clubs", 11),
    ]);
    expect(next.hands[1]).toEqual([card("diamonds", 7), card("diamonds", 6), trump]);
    expect(next.talon).toEqual([]);
    expect(next.trumpCard).toBeNull();
    expect(next.trumpSuit).toBe(trump.suit);
    expect(events.filter((e) => e.type === "TALON_DRAWN")).toEqual([
      {
        type: "TALON_DRAWN",
        by: 0,
        cards: [
          card("spades", 6),
          card("spades", 9),
          card("spades", 10),
          card("clubs", 7),
          card("clubs", 11),
        ],
      },
      {
        type: "TALON_DRAWN",
        by: 1,
        cards: [card("diamonds", 6), trump],
      },
    ]);
  });

  it("attacker first, others in seat order, defender last (3 players)", () => {
    const fivePlus = (suit: Card["suit"], base: number): Card[] => [
      card(suit, base as Card["rank"]),
      card(suit, (base + 1) as Card["rank"]),
      card(suit, (base + 2) as Card["rank"]),
      card(suit, (base + 3) as Card["rank"]),
      card(suit, (base + 4) as Card["rank"]),
    ];
    const state = mkInRound({
      trump,
      talon: [card("spades", 6), card("spades", 9), card("spades", 10)],
      hands: [fivePlus("clubs", 6), fivePlus("diamonds", 6), fivePlus("hearts", 6)],
      table: [{ attack: card("spades", 7), defense: card("spades", 8) }],
      attacker: 0,
      defender: 1,
    });
    const { state: next, events } = expectOk(step(state, { type: "END_ROUND", by: 0 }));
    const drawnSeats = events
      .filter((e): e is Extract<Event, { type: "TALON_DRAWN" }> => e.type === "TALON_DRAWN")
      .map((e) => e.by);
    expect(drawnSeats).toEqual([0, 2, 1]);
    expect(next.hands[0]?.at(-1)).toEqual(card("spades", 6));
    expect(next.hands[2]?.at(-1)).toEqual(card("spades", 9));
    expect(next.hands[1]?.at(-1)).toEqual(card("spades", 10));
  });

  it("does not draw past 6 cards", () => {
    const state = mkInRound({
      trump,
      talon: [
        card("spades", 6),
        card("spades", 9),
        card("spades", 10),
        card("clubs", 7),
        card("clubs", 11),
      ],
      hands: [
        [
          card("clubs", 6),
          card("clubs", 8),
          card("diamonds", 8),
          card("diamonds", 9),
          card("diamonds", 10),
          card("diamonds", 11),
        ],
        [card("hearts", 6)],
      ],
      table: [{ attack: card("spades", 7), defense: card("spades", 8) }],
      attacker: 0,
      defender: 1,
    });
    const { state: next } = expectOk(step(state, { type: "END_ROUND", by: 0 }));
    expect(next.hands[0]).toHaveLength(6);
    expect(next.hands[1]).toHaveLength(6);
  });

  it("consumes trumpCard last when talon is otherwise empty", () => {
    const state = mkInRound({
      trump,
      talon: [card("clubs", 7)],
      hands: [
        [
          card("clubs", 6),
          card("clubs", 8),
          card("clubs", 9),
          card("clubs", 10),
          card("clubs", 12),
        ],
        [card("diamonds", 7)],
      ],
      table: [{ attack: card("spades", 7), defense: card("spades", 8) }],
      attacker: 0,
      defender: 1,
    });
    const { state: next, events } = expectOk(step(state, { type: "END_ROUND", by: 0 }));
    expect(next.hands[0]).toEqual([
      card("clubs", 6),
      card("clubs", 8),
      card("clubs", 9),
      card("clubs", 10),
      card("clubs", 12),
      card("clubs", 7),
    ]);
    expect(next.hands[1]).toEqual([card("diamonds", 7), trump]);
    expect(next.trumpCard).toBeNull();
    expect(next.trumpSuit).toBe(trump.suit);
    const drawn = events.filter(
      (e): e is Extract<Event, { type: "TALON_DRAWN" }> => e.type === "TALON_DRAWN",
    );
    expect(drawn.map((e) => e.by)).toEqual([0, 1]);
    expect(drawn[1]?.cards).toEqual([trump]);
  });

  it("emits TALON_DRAWN only for seats that actually drew", () => {
    const state = mkInRound({
      trump,
      trumpCard: null,
      talon: [card("clubs", 7)],
      hands: [
        [card("clubs", 6)],
        [
          card("diamonds", 7),
          card("diamonds", 8),
          card("diamonds", 9),
          card("diamonds", 10),
          card("diamonds", 11),
          card("diamonds", 12),
        ],
      ],
      table: [{ attack: card("spades", 7), defense: card("spades", 8) }],
      attacker: 0,
      defender: 1,
    });
    const { events } = expectOk(step(state, { type: "END_ROUND", by: 0 }));
    const drawn = events.filter((e) => e.type === "TALON_DRAWN");
    expect(drawn).toEqual([{ type: "TALON_DRAWN", by: 0, cards: [card("clubs", 7)] }]);
  });

  it("uses pre-rotation roles for draw order on TAKE_PILE (3 players)", () => {
    const state = mkInRound({
      trump,
      talon: [card("spades", 9), card("spades", 10), card("spades", 13)],
      hands: [
        [
          card("clubs", 6),
          card("clubs", 8),
          card("clubs", 9),
          card("clubs", 10),
          card("clubs", 12),
        ],
        [card("diamonds", 6), card("diamonds", 8), card("diamonds", 9), card("diamonds", 10)],
        [
          card("hearts", 6),
          card("hearts", 8),
          card("hearts", 9),
          card("hearts", 10),
          card("hearts", 12),
        ],
      ],
      table: [{ attack: card("spades", 7) }],
      attacker: 0,
      defender: 1,
    });
    const { events } = expectOk(step(state, { type: "TAKE_PILE", by: 1 }));
    const drawnSeats = events
      .filter((e) => e.type === "TALON_DRAWN")
      .map((e) => (e as Extract<Event, { type: "TALON_DRAWN" }>).by);
    expect(drawnSeats).toEqual([0, 2, 1]);
  });

  it("does not replenish below 6 if the player already had 6+ cards", () => {
    const fullHand = [
      card("clubs", 6),
      card("clubs", 8),
      card("diamonds", 8),
      card("diamonds", 9),
      card("diamonds", 10),
      card("diamonds", 11),
      card("diamonds", 12),
    ];
    const state = mkInRound({
      trump,
      talon: [card("spades", 9)],
      hands: [fullHand, [card("hearts", 6)]],
      table: [{ attack: card("spades", 7), defense: card("spades", 8) }],
      attacker: 0,
      defender: 1,
    });
    const { state: next } = expectOk(step(state, { type: "END_ROUND", by: 0 }));
    expect(next.hands[0]).toEqual(fullHand);
    expect(next.hands[1]).toEqual([card("hearts", 6), card("spades", 9), trump]);
  });
});

describe("step game-over detection", () => {
  const trump = card("hearts", 11);

  it("transitions to game-over with the durak being the only player still holding cards", () => {
    const state = mkInRound({
      trump,
      trumpCard: null,
      talon: [],
      hands: [[card("clubs", 6)], []],
      table: [{ attack: card("spades", 7), defense: card("spades", 8) }],
      attacker: 0,
      defender: 1,
    });
    const result = step(state, { type: "END_ROUND", by: 0 });
    if (!result.ok) throw new Error(`unexpected: ${result.reason}`);
    expect(result.state.phase).toBe("game-over");
    if (result.state.phase !== "game-over") throw new Error("type guard");
    expect(result.state.durak).toBe(0);
    expect(result.state.hands[0]).toEqual([card("clubs", 6)]);
    expect(result.state.hands[1]).toEqual([]);
    expect(result.events.at(-1)).toEqual({ type: "GAME_OVER", durak: 0 });
  });

  it("declares a draw when every player empties on the same transition", () => {
    const state = mkInRound({
      trump,
      trumpCard: null,
      talon: [],
      hands: [[], []],
      table: [{ attack: card("spades", 7), defense: card("spades", 8) }],
      attacker: 0,
      defender: 1,
    });
    const result = step(state, { type: "END_ROUND", by: 0 });
    if (!result.ok) throw new Error(`unexpected: ${result.reason}`);
    expect(result.state.phase).toBe("game-over");
    if (result.state.phase !== "game-over") throw new Error("type guard");
    expect(result.state.durak).toBeNull();
    expect(result.events.at(-1)).toEqual({ type: "GAME_OVER", durak: null });
  });

  it("does not fire game-over while the talon still has cards", () => {
    const state = mkInRound({
      trump,
      talon: [card("clubs", 7), card("clubs", 8), card("clubs", 9)],
      hands: [
        [
          card("clubs", 6),
          card("diamonds", 6),
          card("diamonds", 7),
          card("diamonds", 8),
          card("diamonds", 9),
        ],
        [
          card("hearts", 6),
          card("hearts", 7),
          card("hearts", 8),
          card("hearts", 9),
          card("hearts", 10),
        ],
      ],
      table: [{ attack: card("spades", 7), defense: card("spades", 8) }],
      attacker: 0,
      defender: 1,
    });
    const { state: next } = expectOk(step(state, { type: "END_ROUND", by: 0 }));
    expect(next.phase).toBe("in-round");
    if (next.phase !== "in-round") return;
    expect(next.talon.length + (next.trumpCard ? 1 : 0)).toBeGreaterThan(0);
  });

  it("does not fire game-over while two players still have cards", () => {
    const state = mkInRound({
      trump,
      trumpCard: null,
      talon: [],
      hands: [[card("clubs", 6)], [card("diamonds", 9)]],
      table: [{ attack: card("spades", 7), defense: card("spades", 8) }],
      attacker: 0,
      defender: 1,
    });
    const { state: next } = expectOk(step(state, { type: "END_ROUND", by: 0 }));
    expect(next.phase).toBe("in-round");
  });

  it("rejects further actions once in game-over phase", () => {
    const state = mkInRound({
      trump,
      trumpCard: null,
      talon: [],
      hands: [[card("clubs", 6)], []],
      table: [{ attack: card("spades", 7), defense: card("spades", 8) }],
      attacker: 0,
      defender: 1,
    });
    const result = step(state, { type: "END_ROUND", by: 0 });
    if (!result.ok || result.state.phase !== "game-over") throw new Error("setup failed");
    expect(step(result.state, { type: "ATTACK", by: 0, card: card("clubs", 6) })).toEqual({
      ok: false,
      reason: "WRONG_PHASE",
    });
    expect(step(result.state, { type: "TIMEOUT", by: 0 })).toEqual({
      ok: false,
      reason: "WRONG_PHASE",
    });
  });
});

describe("step TIMEOUT", () => {
  const trump = card("hearts", 11);

  it("on defender-side timeout: defender takes the pile", () => {
    const state = mkInRound({
      trump,
      trumpCard: null,
      talon: [],
      hands: [[card("clubs", 6), card("clubs", 7)], [card("diamonds", 9)]],
      table: [{ attack: card("spades", 7) }],
      attacker: 0,
      defender: 1,
    });
    const { state: next, events } = expectOk(step(state, { type: "TIMEOUT", by: 1 }));
    expect(next.hands[1]).toEqual([card("diamonds", 9), card("spades", 7)]);
    expect(next.table).toEqual([]);
    expect(events[0]?.type).toBe("PILE_TAKEN");
  });

  it("on attacker-side timeout: attacker ends the round", () => {
    const state = mkInRound({
      trump,
      trumpCard: null,
      talon: [],
      hands: [[card("clubs", 6)], [card("diamonds", 9)]],
      table: [{ attack: card("spades", 7), defense: card("spades", 8) }],
      attacker: 0,
      defender: 1,
    });
    const { state: next, events } = expectOk(step(state, { type: "TIMEOUT", by: 0 }));
    expect(next.table).toEqual([]);
    expect(next.discard).toEqual([card("spades", 7), card("spades", 8)]);
    expect(events[0]?.type).toBe("ROUND_ENDED");
  });

  it("rejects when the attacker times out with undefended attacks", () => {
    const state = mkInRound({
      trump,
      trumpCard: null,
      talon: [],
      hands: [[card("clubs", 6)], [card("diamonds", 9)]],
      table: [{ attack: card("spades", 7) }],
      attacker: 0,
      defender: 1,
    });
    expect(step(state, { type: "TIMEOUT", by: 0 })).toEqual({
      ok: false,
      reason: "ATTACKS_UNDEFENDED",
    });
  });

  it("rejects when the defender times out with an empty table", () => {
    const state = mkInRound({
      trump,
      hands: [[card("clubs", 6)], [card("diamonds", 9)]],
      table: [],
      attacker: 0,
      defender: 1,
    });
    expect(step(state, { type: "TIMEOUT", by: 1 })).toEqual({
      ok: false,
      reason: "TABLE_EMPTY",
    });
  });

  it("rejects an out-of-range seat", () => {
    const state = mkInRound({
      trump,
      hands: [[card("clubs", 6)], [card("diamonds", 9)]],
      table: [{ attack: card("spades", 7) }],
      attacker: 0,
      defender: 1,
    });
    expect(step(state, { type: "TIMEOUT", by: 5 })).toEqual({
      ok: false,
      reason: "INVALID_SEAT",
    });
  });

  it("rejects a seat that is neither attacker nor defender (3 players)", () => {
    const state = mkInRound({
      trump,
      hands: [[card("clubs", 6)], [card("diamonds", 9)], [card("hearts", 14)]],
      table: [{ attack: card("spades", 7) }],
      attacker: 0,
      defender: 1,
    });
    expect(step(state, { type: "TIMEOUT", by: 2 })).toEqual({
      ok: false,
      reason: "TIMEOUT_NOT_ACTIVE_SEAT",
    });
  });

  it("rejects when phase is not in-round", () => {
    expect(step(initialState({ seed: 1 }), { type: "TIMEOUT", by: 0 })).toEqual({
      ok: false,
      reason: "WRONG_PHASE",
    });
  });
});

describe("step full-game property", () => {
  it("a randomized 1v1 game completes with exactly one durak (or draw) and conserves cards", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20000 }), (seed) => {
        let s: State = deal(seed, 2);
        if (s.phase !== "in-round") throw new Error("expected in-round after deal");
        let steps = 0;
        const STEP_CAP = 4000;
        while (s.phase === "in-round" && steps < STEP_CAP) {
          const action = pickLegalAction(s, seed * 31 + steps, s.trumpSuit);
          if (!action) throw new Error("no legal action available before game-over");
          const r = step(s, action);
          if (!r.ok) throw new Error(`unexpected rejection: ${r.reason}`);
          s = r.state;
          if (s.phase === "in-round") {
            expect(totalCards(s)).toBe(36);
            expect(uniqueCardCount(s)).toBe(36);
          }
          steps++;
        }
        expect(s.phase).toBe("game-over");
        if (s.phase !== "game-over") return;
        expect(totalCards(s)).toBe(36);
        expect(uniqueCardCount(s)).toBe(36);
        const withCards = s.hands.filter((h) => h.length > 0).length;
        if (s.durak === null) {
          expect(withCards).toBe(0);
        } else {
          expect(withCards).toBe(1);
          expect(s.hands[s.durak]?.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe("step golden full-game trace", () => {
  it("produces a byte-identical event trace from a fixed seed (deterministic chooser)", () => {
    const runOnce = () => {
      let s: State = deal(7, 2);
      const allEvents: Event[] = [];
      let steps = 0;
      while (s.phase === "in-round" && steps < 4000) {
        if (s.phase !== "in-round") break;
        const action = pickLegalAction(s, 7 * 31 + steps, s.trumpSuit);
        if (!action) throw new Error("no legal action");
        const r = step(s, action);
        if (!r.ok) throw new Error(`rejection: ${r.reason}`);
        for (const e of r.events) allEvents.push(e);
        s = r.state;
        steps++;
      }
      return { steps, finalPhase: s.phase, events: allEvents };
    };
    const a = runOnce();
    const b = runOnce();
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(a.finalPhase).toBe("game-over");
    expect(a.events.at(-1)?.type).toBe("GAME_OVER");
  });
});
