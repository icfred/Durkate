import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Card, Suit } from "./cards";
import { createRng } from "./rng";
import { type InRoundState, initialState, type State, type TablePair } from "./state";
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
}): InRoundState {
  const playerCount = opts.hands.length;
  const attacker = opts.attacker ?? 0;
  return {
    phase: "in-round",
    playerCount,
    rng: createRng(0).state,
    hands: opts.hands.map((h) => [...h]),
    talon: opts.talon ?? [],
    trump: opts.trump,
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
    expect(s.trump).toBeDefined();
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
      hand.filter((c) => c.suit === s.trump.suit).map((c) => c.rank),
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
      trump: state.trump,
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
        const all = [...s.hands.flat(), ...s.talon, s.trump];
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

describe("step exhaustiveness", () => {
  it("throws on an unknown action variant", () => {
    const s = deal(1, 2);
    expect(() => step(s, { type: "UNKNOWN" } as unknown as Action)).toThrow();
  });
});

function totalCards(s: InRoundState): number {
  let defenseCount = 0;
  for (const p of s.table) if (p.defense) defenseCount++;
  return (
    s.hands.flat().length + s.table.length + defenseCount + s.talon.length + 1 + s.discard.length
  );
}

function uniqueCardCount(s: InRoundState): number {
  const keys = new Set<string>();
  for (const card of s.hands.flat()) keys.add(cardKey(card));
  for (const p of s.table) {
    keys.add(cardKey(p.attack));
    if (p.defense) keys.add(cardKey(p.defense));
  }
  for (const card of s.talon) keys.add(cardKey(card));
  for (const card of s.discard) keys.add(cardKey(card));
  keys.add(cardKey(s.trump));
  return keys.size;
}

function pickLegalAction(s: InRoundState, choice: number, trumpSuit: Suit): Action | null {
  const attackerHand = s.hands[s.attacker] as Card[];
  const defenderHand = s.hands[s.defender] as Card[];

  const tryDefend = (): Action | null => {
    const undefendedIdx = s.table.findIndex((p) => !p.defense);
    if (undefendedIdx < 0) return null;
    const target = s.table[undefendedIdx] as TablePair;
    const defenders = defenderHand.filter((c) => beats(c, target.attack, trumpSuit));
    if (defenders.length === 0) return null;
    const card = defenders[choice % defenders.length] as Card;
    return { type: "DEFEND", by: s.defender, card, target: undefendedIdx };
  };

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
    const undefendedCount = s.table.reduce((n, p) => (p.defense ? n : n + 1), 0);
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

  return tryDefend();
}

describe("step invariants under random legal play (property)", () => {
  it("preserves the 36-card total and uniqueness", () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.array(fc.nat(), { minLength: 1, maxLength: 30 }),
        (seed, choices) => {
          let s: State = deal(seed, 2);
          if (s.phase !== "in-round") return;
          expect(totalCards(s)).toBe(36);
          expect(uniqueCardCount(s)).toBe(36);

          for (const choice of choices) {
            if (s.phase !== "in-round") break;
            const action = pickLegalAction(s, choice, s.trump.suit);
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
      { numRuns: 100 },
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
            const action = pickLegalAction(s, choice, s.trump.suit);
            if (!action) break;
            const r = step(s, action);
            if (!r.ok) throw new Error(`rejection: ${r.reason}`);
            s = r.state;
            if (s.phase !== "in-round") break;
            for (const p of s.table) {
              if (p.defense) {
                expect(beats(p.defense, p.attack, s.trump.suit)).toBe(true);
              }
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
