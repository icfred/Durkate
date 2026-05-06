// Card backgrounds: the predominate "body" colour of a card. By convention
// the pattern's region 0 and region 1 both render as this colour, leaving
// regions 2..7 for vibrant colorway accents. Backgrounds are deliberately
// muted off-blacks and off-whites — keeping the dominant area legible
// across colorways and giving glyph rendering a predictable contrast
// substrate. Wear also reveals this colour (slightly darkened), so chips
// look like card material under the pattern surface.

export interface CardBackground {
  name: string;
  color: number;
}

export const CARD_BACKGROUNDS: readonly CardBackground[] = [
  { name: "noir", color: 0x141416 },
  { name: "slate", color: 0x1d2229 },
  { name: "ash", color: 0x2c2e34 },
  { name: "linen", color: 0xeae5d8 },
  { name: "parchment", color: 0xd5c5a0 },
  { name: "bone", color: 0xefebd9 },
];

export const CARD_BACKGROUND_COUNT = CARD_BACKGROUNDS.length;
