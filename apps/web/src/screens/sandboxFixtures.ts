import type { Snapshot } from "@durak/protocol";

export type FixtureName =
  | "fresh"
  | "midround"
  | "takepile"
  | "trumpdrawn"
  | "gameover"
  | "ffa-3"
  | "ffa-4"
  | "ffa-5"
  | "ffa-6";

export const FIXTURE_NAMES: readonly FixtureName[] = [
  "fresh",
  "midround",
  "takepile",
  "trumpdrawn",
  "gameover",
  "ffa-3",
  "ffa-4",
  "ffa-5",
  "ffa-6",
];

const trump = { suit: "hearts", rank: 6 } as const;
const trumpSuit = "hearts" as const;

const fresh: Snapshot = {
  phase: "in-round",
  playerCount: 2,
  handCounts: [6, 6],
  talonCount: 23,
  trump,
  trumpSuit,
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
  trumpSuit,
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
  trumpSuit,
  // Single undefended trump-ace attack — nothing in the standard deck
  // beats a trump 14, so the defender's only legal action is TAKE PILE.
  // Drives the forced-action affordance for fixture-based testing.
  table: [{ attack: { suit: "hearts", rank: 14 } }],
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
      { suit: "spades", rank: 7 },
      { suit: "clubs", rank: 8 },
    ],
  },
};

const trumpdrawn: Snapshot = {
  phase: "in-round",
  playerCount: 2,
  handCounts: [4, 4],
  talonCount: 0,
  trump: null,
  trumpSuit,
  table: [],
  attacker: 0,
  defender: 1,
  discard: [
    { suit: "spades", rank: 7 },
    { suit: "clubs", rank: 9 },
  ],
  seat: 0,
  you: {
    seat: 0,
    hand: [
      { suit: "spades", rank: 10 },
      { suit: "clubs", rank: 11 },
      { suit: "diamonds", rank: 12 },
      { suit: "hearts", rank: 14 },
    ],
  },
};

const gameover: Snapshot = {
  phase: "in-round",
  playerCount: 2,
  handCounts: [0, 1],
  talonCount: 0,
  trump,
  trumpSuit,
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

function ffaFixture(playerCount: 3 | 4 | 5 | 6): Snapshot {
  const handCounts = Array.from({ length: playerCount }, (_, i) => (i === 2 ? 4 : 6));
  return {
    phase: "in-round",
    playerCount,
    handCounts,
    talonCount: Math.max(0, 36 - playerCount * 6),
    trump,
    trumpSuit,
    table: [
      {
        attack: { suit: "spades", rank: 8 },
        defense: { suit: "spades", rank: 12 },
      },
      { attack: { suit: "clubs", rank: 8 } },
    ],
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
}

const FIXTURES: Record<FixtureName, Snapshot> = {
  fresh,
  midround,
  takepile,
  trumpdrawn,
  gameover,
  "ffa-3": ffaFixture(3),
  "ffa-4": ffaFixture(4),
  "ffa-5": ffaFixture(5),
  "ffa-6": ffaFixture(6),
};

export function loadFixture(name: FixtureName): Snapshot {
  return FIXTURES[name];
}

export function isFixtureName(value: string): value is FixtureName {
  return (FIXTURE_NAMES as readonly string[]).includes(value);
}
