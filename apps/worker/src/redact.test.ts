import {
  type Action,
  type Card,
  type InRoundState,
  initialState,
  type State,
  step,
} from "@durak/engine";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { RedactionPhaseError, redactFor } from "./redact.js";

function startedState(seed: number): State {
  const result = step(initialState({ seed }), { type: "START_GAME" });
  if (!result.ok) throw new Error(`START_GAME failed: ${result.reason}`);
  return result.state;
}

function cardKey(card: Card): string {
  return `${card.suit}:${card.rank}`;
}

function trySomeAction(state: State, choice: number): State {
  if (state.phase !== "in-round") return state;
  const candidates: Action[] = [];
  const attackerHand = state.hands[state.attacker] ?? [];
  const defenderHand = state.hands[state.defender] ?? [];
  for (const c of attackerHand) {
    if (state.table.length === 0) {
      candidates.push({ type: "ATTACK", by: state.attacker, card: c });
    } else {
      candidates.push({ type: "THROW_IN", by: state.attacker, card: c });
    }
  }
  for (let i = 0; i < state.table.length; i++) {
    const pair = state.table[i];
    if (!pair || pair.defense !== undefined) continue;
    for (const c of defenderHand) {
      candidates.push({
        type: "DEFEND",
        by: state.defender,
        card: c,
        target: i,
      });
    }
  }
  if (state.table.length > 0) {
    candidates.push({ type: "TAKE_PILE", by: state.defender });
    candidates.push({ type: "END_ROUND", by: state.attacker });
  }
  if (candidates.length === 0) return state;
  for (let i = 0; i < candidates.length; i++) {
    const idx = (choice + i) % candidates.length;
    const tryAction = candidates[idx];
    if (!tryAction) continue;
    const result = step(state, tryAction);
    if (result.ok) return result.state;
  }
  return state;
}

describe("redactFor", () => {
  it("throws on pre-deal phase", () => {
    const pre = initialState({ seed: 1 });
    expect(() => redactFor(pre, 0)).toThrow(RedactionPhaseError);
  });

  it("throws on out-of-range seat", () => {
    const state = startedState(1);
    expect(() => redactFor(state, 2)).toThrow(RangeError);
    expect(() => redactFor(state, -1)).toThrow(RangeError);
  });

  it("returns the requesting seat's own hand verbatim", () => {
    const state = startedState(42);
    if (state.phase !== "in-round") throw new Error("expected in-round");
    const snap0 = redactFor(state, 0);
    const snap1 = redactFor(state, 1);
    expect(snap0.you.hand).toEqual(state.hands[0]);
    expect(snap1.you.hand).toEqual(state.hands[1]);
    expect(snap0.you.seat).toBe(0);
    expect(snap1.you.seat).toBe(1);
  });

  it("maps trump and trumpSuit directly when the trump card is still face-up", () => {
    const state = startedState(42);
    if (state.phase !== "in-round") throw new Error("expected in-round");
    const snap = redactFor(state, 0);
    expect(snap.trump).toEqual(state.trumpCard);
    expect(snap.trumpSuit).toBe(state.trumpSuit);
    expect(snap.trump).not.toBeNull();
  });

  it("returns trump=null with trumpSuit set once the trump card has been drawn", () => {
    const base = startedState(7);
    if (base.phase !== "in-round") throw new Error("expected in-round");
    const drawn: InRoundState = { ...base, trumpCard: null, talon: [] };
    const snap = redactFor(drawn, 0);
    expect(snap.trump).toBeNull();
    expect(snap.trumpSuit).toBe(base.trumpSuit);
    expect(snap.talonCount).toBe(0);
  });

  it("never names talon, hands, or rng on the snapshot object", () => {
    const state = startedState(7);
    const snap = redactFor(state, 0);
    expect(Object.hasOwn(snap, "talon")).toBe(false);
    expect(Object.hasOwn(snap, "hands")).toBe(false);
    expect(Object.hasOwn(snap, "rng")).toBe(false);
    expect(Object.hasOwn(snap.you, "talon")).toBe(false);
    expect(Object.hasOwn(snap.you, "hands")).toBe(false);
    expect(Object.hasOwn(snap.you, "rng")).toBe(false);
  });

  it("property: snapshot for seat S contains no card from opponent's hand or talon across a random walk", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.array(fc.integer({ min: 0, max: 200 }), { minLength: 0, maxLength: 50 }),
        (seed, choices) => {
          let state: State = startedState(seed);
          if (state.phase !== "in-round") return;
          for (const choice of choices) {
            state = trySomeAction(state, choice);
          }
          if (state.phase !== "in-round") return;
          for (const seat of [0, 1] as const) {
            const opponent = (seat + 1) % 2;
            const opponentHand = state.hands[opponent] ?? [];
            const talon = state.talon;
            const snap = redactFor(state, seat);
            const serialized = JSON.stringify(snap);
            const ownHandKeys = new Set((state.hands[seat] ?? []).map(cardKey));
            const tableKeys = new Set<string>();
            for (const pair of state.table) {
              tableKeys.add(cardKey(pair.attack));
              if (pair.defense) tableKeys.add(cardKey(pair.defense));
            }
            const discardKeys = new Set(state.discard.map(cardKey));
            const trumpKey = state.trumpCard ? cardKey(state.trumpCard) : null;
            for (const card of opponentHand) {
              const key = cardKey(card);
              if (ownHandKeys.has(key) || tableKeys.has(key) || discardKeys.has(key)) continue;
              if (trumpKey !== null && key === trumpKey) continue;
              expect(serialized).not.toContain(`"suit":"${card.suit}","rank":${card.rank}`);
            }
            for (const card of talon) {
              const key = cardKey(card);
              if (trumpKey !== null && key === trumpKey) continue;
              expect(serialized).not.toContain(`"suit":"${card.suit}","rank":${card.rank}`);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("property: hand counts and table contents match the engine state for both seats", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.array(fc.integer({ min: 0, max: 200 }), { minLength: 0, maxLength: 30 }),
        (seed, choices) => {
          let state: State = startedState(seed);
          if (state.phase !== "in-round") return;
          for (const choice of choices) {
            state = trySomeAction(state, choice);
          }
          if (state.phase !== "in-round") return;
          for (const seat of [0, 1] as const) {
            const snap = redactFor(state, seat);
            expect(snap.handCounts).toEqual(state.hands.map((h) => h.length));
            expect(snap.attacker).toBe(state.attacker);
            expect(snap.defender).toBe(state.defender);
            expect(snap.trump).toEqual(state.trumpCard);
            expect(snap.trumpSuit).toBe(state.trumpSuit);
            expect(snap.table.length).toBe(state.table.length);
            for (let i = 0; i < state.table.length; i++) {
              const enginePair = state.table[i];
              const snapPair = snap.table[i];
              if (!enginePair || !snapPair) continue;
              expect(snapPair.attack).toEqual(enginePair.attack);
              if (enginePair.defense) {
                expect(snapPair.defense).toEqual(enginePair.defense);
              } else {
                expect(snapPair.defense).toBeUndefined();
              }
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
