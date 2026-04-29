export const SUITS = ["spades", "hearts", "diamonds", "clubs"] as const;
export type Suit = (typeof SUITS)[number];

export const RANKS = [6, 7, 8, 9, 10, 11, 12, 13, 14] as const;
export type Rank = (typeof RANKS)[number];

export interface Card {
  readonly suit: Suit;
  readonly rank: Rank;
}

export function buildDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank });
    }
  }
  return deck;
}
