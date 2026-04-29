import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Card, Suit } from "../cards";
import { createRng } from "../rng";
import { type GameOverState, type InRoundState, initialState, type State } from "../state";
import { type Action, type Event, step } from "../step";
import { choose } from "./index";

const cardKey = (c: Card) => `${c.suit}-${c.rank}`;
const card = (suit: Suit, rank: number): Card => ({ suit, rank: rank as Card["rank"] });

function deal(seed: number, playerCount = 2): InRoundState {
  const init = initialState({ seed, playerCount });
  const result = step(init, { type: "START_GAME" });
  if (!result.ok) throw new Error(`START_GAME rejected: ${result.reason}`);
  if (result.state.phase !== "in-round") throw new Error("expected in-round");
  return result.state;
}

function playToCompletion(seed: number, playerCount = 2, stepCap = 4000) {
  let state: State = deal(seed, playerCount);
  const events: Event[] = [];
  const actions: Action[] = [];
  let steps = 0;
  while (state.phase === "in-round" && steps < stepCap) {
    const action = choose(state);
    actions.push(action);
    const result = step(state, action);
    if (!result.ok) throw new Error(`bot produced illegal action: ${result.reason}`);
    for (const event of result.events) events.push(event);
    state = result.state;
    steps++;
  }
  if (state.phase !== "game-over") {
    throw new Error(`game did not complete in ${stepCap} steps`);
  }
  return { state: state as GameOverState, events, actions, steps };
}

describe("bot.choose phase guard", () => {
  it("throws when called on a pre-deal state", () => {
    expect(() => choose(initialState({ seed: 1 }))).toThrow();
  });

  it("throws when called on a game-over state", () => {
    const overState: GameOverState = {
      phase: "game-over",
      playerCount: 2,
      rng: createRng(1).state,
      hands: [[], [card("clubs", 6)]],
      trumpSuit: "hearts",
      trumpCard: null,
      discard: [],
      durak: 1,
    };
    expect(() => choose(overState)).toThrow();
  });
});

describe("bot.choose attack heuristic", () => {
  const trump: Suit = "hearts";

  it("opens with the lowest non-trump card", () => {
    const state: InRoundState = {
      phase: "in-round",
      playerCount: 2,
      rng: createRng(0).state,
      hands: [[card("hearts", 6), card("clubs", 9), card("spades", 7)], [card("diamonds", 14)]],
      talon: [],
      trumpSuit: trump,
      trumpCard: null,
      table: [],
      attacker: 0,
      defender: 1,
      discard: [],
    };
    const action = choose(state);
    expect(action).toEqual({ type: "ATTACK", by: 0, card: card("spades", 7) });
  });

  it("falls back to the lowest trump when only trumps are held", () => {
    const state: InRoundState = {
      phase: "in-round",
      playerCount: 2,
      rng: createRng(0).state,
      hands: [[card("hearts", 9), card("hearts", 7)], [card("diamonds", 14)]],
      talon: [],
      trumpSuit: trump,
      trumpCard: null,
      table: [],
      attacker: 0,
      defender: 1,
      discard: [],
    };
    const action = choose(state);
    expect(action).toEqual({ type: "ATTACK", by: 0, card: card("hearts", 7) });
  });
});

describe("bot.choose defense heuristic", () => {
  const trump: Suit = "hearts";

  it("defends with the cheapest same-suit beat over a trump", () => {
    const state: InRoundState = {
      phase: "in-round",
      playerCount: 2,
      rng: createRng(0).state,
      hands: [[card("clubs", 6)], [card("spades", 9), card("spades", 11), card("hearts", 6)]],
      talon: [],
      trumpSuit: trump,
      trumpCard: null,
      table: [{ attack: card("spades", 8) }],
      attacker: 0,
      defender: 1,
      discard: [],
    };
    expect(choose(state)).toEqual({
      type: "DEFEND",
      by: 1,
      card: card("spades", 9),
      target: 0,
    });
  });

  it("uses the lowest trump when no same-suit beat is available", () => {
    const state: InRoundState = {
      phase: "in-round",
      playerCount: 2,
      rng: createRng(0).state,
      hands: [[card("clubs", 6)], [card("hearts", 6), card("hearts", 8)]],
      talon: [],
      trumpSuit: trump,
      trumpCard: null,
      table: [{ attack: card("spades", 9) }],
      attacker: 0,
      defender: 1,
      discard: [],
    };
    expect(choose(state)).toEqual({
      type: "DEFEND",
      by: 1,
      card: card("hearts", 6),
      target: 0,
    });
  });

  it("takes the pile when no defense exists", () => {
    const state: InRoundState = {
      phase: "in-round",
      playerCount: 2,
      rng: createRng(0).state,
      hands: [[card("clubs", 6)], [card("clubs", 7), card("diamonds", 9)]],
      talon: [],
      trumpSuit: trump,
      trumpCard: null,
      table: [{ attack: card("spades", 10) }],
      attacker: 0,
      defender: 1,
      discard: [],
    };
    expect(choose(state)).toEqual({ type: "TAKE_PILE", by: 1 });
  });

  it("takes the pile rather than burn a high trump on a low attack", () => {
    const state: InRoundState = {
      phase: "in-round",
      playerCount: 2,
      rng: createRng(0).state,
      hands: [[card("clubs", 6)], [card("hearts", 13), card("clubs", 9)]],
      talon: [],
      trumpSuit: trump,
      trumpCard: null,
      table: [{ attack: card("spades", 7) }],
      attacker: 0,
      defender: 1,
      discard: [],
    };
    expect(choose(state)).toEqual({ type: "TAKE_PILE", by: 1 });
  });

  it("does not consider it 'burning' when attack is itself a trump", () => {
    const state: InRoundState = {
      phase: "in-round",
      playerCount: 2,
      rng: createRng(0).state,
      hands: [[card("clubs", 6)], [card("hearts", 13)]],
      talon: [],
      trumpSuit: trump,
      trumpCard: null,
      table: [{ attack: card("hearts", 7) }],
      attacker: 0,
      defender: 1,
      discard: [],
    };
    expect(choose(state)).toEqual({
      type: "DEFEND",
      by: 1,
      card: card("hearts", 13),
      target: 0,
    });
  });
});

describe("bot.choose throw-in heuristic", () => {
  const trump: Suit = "hearts";

  it("throws in the cheapest matching non-trump rank", () => {
    const state: InRoundState = {
      phase: "in-round",
      playerCount: 2,
      rng: createRng(0).state,
      hands: [
        [card("clubs", 13), card("clubs", 8), card("spades", 12)],
        [card("hearts", 14), card("clubs", 14)],
      ],
      talon: [],
      trumpSuit: trump,
      trumpCard: null,
      table: [{ attack: card("spades", 8), defense: card("spades", 9) }],
      attacker: 0,
      defender: 1,
      discard: [],
    };
    expect(choose(state)).toEqual({
      type: "THROW_IN",
      by: 0,
      card: card("clubs", 8),
    });
  });

  it("ends the round when no rank on the table matches the attacker's hand", () => {
    const state: InRoundState = {
      phase: "in-round",
      playerCount: 2,
      rng: createRng(0).state,
      hands: [[card("diamonds", 13)], [card("hearts", 14)]],
      talon: [],
      trumpSuit: trump,
      trumpCard: null,
      table: [{ attack: card("spades", 8), defense: card("spades", 9) }],
      attacker: 0,
      defender: 1,
      discard: [],
    };
    expect(choose(state)).toEqual({ type: "END_ROUND", by: 0 });
  });

  it("ends the round when the defender has no cards left to cover one more", () => {
    const state: InRoundState = {
      phase: "in-round",
      playerCount: 2,
      rng: createRng(0).state,
      hands: [[card("clubs", 8)], []],
      talon: [],
      trumpSuit: trump,
      trumpCard: null,
      table: [{ attack: card("spades", 8), defense: card("spades", 9) }],
      attacker: 0,
      defender: 1,
      discard: [],
    };
    expect(choose(state)).toEqual({ type: "END_ROUND", by: 0 });
  });

  it("ends the round when the bout already has six attacks", () => {
    const ranks = [6, 7, 8, 9, 10, 11];
    const state: InRoundState = {
      phase: "in-round",
      playerCount: 2,
      rng: createRng(0).state,
      hands: [
        [card("clubs", 6), card("clubs", 7)],
        [card("hearts", 14), card("hearts", 13)],
      ],
      talon: [],
      trumpSuit: trump,
      trumpCard: null,
      table: ranks.map((r) => ({
        attack: card("spades", r),
        defense: card("clubs", r),
      })),
      attacker: 0,
      defender: 1,
      discard: [],
    };
    expect(choose(state)).toEqual({ type: "END_ROUND", by: 0 });
  });
});

describe("bot.choose purity", () => {
  it("does not mutate state.rng when computing an action", () => {
    const state: InRoundState = {
      phase: "in-round",
      playerCount: 2,
      rng: createRng(2026).state,
      hands: [[card("clubs", 6), card("spades", 7)], [card("hearts", 14)]],
      talon: [],
      trumpSuit: "hearts",
      trumpCard: null,
      table: [],
      attacker: 0,
      defender: 1,
      discard: [],
    };
    const before: readonly [number, number, number, number] = [
      state.rng[0],
      state.rng[1],
      state.rng[2],
      state.rng[3],
    ];
    choose(state);
    expect(state.rng).toEqual(before);
  });

  it("returns the same action for the same input on repeated calls", () => {
    const state = deal(2026, 2);
    const a = choose(state);
    const b = choose(state);
    expect(a).toEqual(b);
  });
});

describe("bot vs bot self-play", () => {
  it("plays a 1v1 game from a fixed seed to game-over", () => {
    const { state, steps } = playToCompletion(2026, 2);
    expect(state.phase).toBe("game-over");
    expect(steps).toBeGreaterThan(0);
    // exactly one durak (or a draw) — matches engine acceptance for full game.
    const withCards = state.hands.filter((h) => h.length > 0).length;
    if (state.durak === null) {
      expect(withCards).toBe(0);
    } else {
      expect(withCards).toBe(1);
      expect(state.hands[state.durak]?.length).toBeGreaterThan(0);
    }
  });

  it("is byte-identical across runs for a known seed (golden trace)", () => {
    const a = playToCompletion(2026, 2);
    const b = playToCompletion(2026, 2);
    expect(JSON.stringify(b.actions)).toBe(JSON.stringify(a.actions));
    expect(JSON.stringify(b.events)).toBe(JSON.stringify(a.events));
    expect(a.steps).toBe(b.steps);
    expect(a.state).toEqual(b.state);
    expect(a.events.at(-1)?.type).toBe("GAME_OVER");
  });

  it("conserves all 36 cards through the game", () => {
    const { state, events } = playToCompletion(2026, 2);
    const keys = new Set<string>();
    for (const c of state.hands.flat()) keys.add(cardKey(c));
    for (const c of state.discard) keys.add(cardKey(c));
    if (state.trumpCard) keys.add(cardKey(state.trumpCard));
    expect(keys.size).toBe(36);
    expect(events.at(-1)).toEqual({ type: "GAME_OVER", durak: state.durak });
  });

  it("reaches game-over for a wide range of seeds (property)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20000 }), (seed) => {
        const { state } = playToCompletion(seed, 2);
        expect(state.phase).toBe("game-over");
      }),
      { numRuns: 200 },
    );
  });

  it("never produces an illegal action across self-play (property)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20000 }), (seed) => {
        playToCompletion(seed, 2);
      }),
      { numRuns: 200 },
    );
  });
});
