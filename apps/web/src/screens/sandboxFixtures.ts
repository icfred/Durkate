import type { Snapshot } from "@durak/protocol";

export type FixtureName = "fresh" | "midround" | "takepile" | "gameover";

export const FIXTURE_NAMES: readonly FixtureName[] = ["fresh", "midround", "takepile", "gameover"];

const trump = { suit: "hearts", rank: 6 } as const;

const fresh: Snapshot = {
  phase: "in-round",
  playerCount: 2,
  handCounts: [6, 6],
  talonCount: 23,
  trump,
  table: [],
  attacker: 0,
  defender: 1,
  discard: [],
  seat: 0,
  you: {
    seat: 0,
    hand: [
      { suit: "spades", rank: 7 },
      { suit: "clubs", rank: 9 },
      { suit: "diamonds", rank: 10 },
      { suit: "hearts", rank: 11 },
      { suit: "spades", rank: 13 },
      { suit: "clubs", rank: 14 },
    ],
  },
};

const midround: Snapshot = {
  phase: "in-round",
  playerCount: 2,
  handCounts: [4, 3],
  talonCount: 18,
  trump,
  table: [
    {
      attack: { suit: "spades", rank: 8 },
      defense: { suit: "spades", rank: 12 },
    },
    {
      attack: { suit: "clubs", rank: 8 },
    },
  ],
  attacker: 0,
  defender: 1,
  discard: [],
  seat: 1,
  you: {
    seat: 1,
    hand: [
      { suit: "clubs", rank: 11 },
      { suit: "hearts", rank: 9 },
      { suit: "diamonds", rank: 13 },
    ],
  },
};

const takepile: Snapshot = {
  phase: "in-round",
  playerCount: 2,
  handCounts: [3, 2],
  talonCount: 12,
  trump,
  table: [
    { attack: { suit: "diamonds", rank: 6 } },
    { attack: { suit: "clubs", rank: 6 } },
    { attack: { suit: "spades", rank: 6 } },
  ],
  attacker: 0,
  defender: 1,
  discard: [
    { suit: "hearts", rank: 7 },
    { suit: "spades", rank: 9 },
  ],
  seat: 1,
  you: {
    seat: 1,
    hand: [
      { suit: "diamonds", rank: 7 },
      { suit: "clubs", rank: 8 },
    ],
  },
};

const gameover: Snapshot = {
  phase: "in-round",
  playerCount: 2,
  handCounts: [0, 1],
  talonCount: 0,
  trump,
  table: [],
  attacker: 1,
  defender: 0,
  discard: [
    { suit: "spades", rank: 10 },
    { suit: "clubs", rank: 10 },
    { suit: "hearts", rank: 12 },
    { suit: "diamonds", rank: 12 },
  ],
  seat: 1,
  you: {
    seat: 1,
    hand: [{ suit: "diamonds", rank: 14 }],
  },
};

const FIXTURES: Record<FixtureName, Snapshot> = {
  fresh,
  midround,
  takepile,
  gameover,
};

export function loadFixture(name: FixtureName): Snapshot {
  return FIXTURES[name];
}

export function isFixtureName(value: string): value is FixtureName {
  return (FIXTURE_NAMES as readonly string[]).includes(value);
}
