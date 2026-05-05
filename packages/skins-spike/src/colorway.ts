// Colorways: separated from pattern shape so PatternBundle can hold pure
// structure (height + regionId + finishMask) and the colors come from a
// freely-swappable palette. A pattern recipe produces 8 regions; the
// colorway maps each region index to a palette color. Same shape × six
// colorways = six different visual results from one set of textures.
//
// The full set ships with createSkinAssets so the spec's `colorway`
// field can index into it deterministically.

export const PALETTE_SIZE = 8;

export interface Colorway {
  name: string;
  palette: readonly number[];
}

export const COLORWAYS: readonly Colorway[] = [
  {
    name: "ocean",
    palette: [0x0b1d2a, 0x1a4c6e, 0x2d8aa8, 0x6cd4ff, 0xffd166, 0x122c40, 0x3a92b8, 0x7be0d4],
  },
  {
    name: "copper",
    palette: [0x1a0f08, 0x6e3a1c, 0xb86a32, 0xeaa75e, 0xfff1d0, 0x2a1a0e, 0x8c4a24, 0xd9a878],
  },
  {
    name: "forest",
    palette: [0x0f1a14, 0x2a4a2e, 0x5b8c3e, 0xa3c46b, 0xe8e0a8, 0x182a1c, 0x436b34, 0x80a854],
  },
  {
    name: "cyber",
    palette: [0x07021a, 0x2a0a4a, 0x6b1aa8, 0xff37c8, 0x42f5b8, 0x14064a, 0x9a2ad8, 0x60ffe2],
  },
  {
    name: "ember",
    palette: [0x1a0606, 0x4a1818, 0xb83232, 0xff8a5e, 0xffe7a8, 0x2c0c0c, 0x892020, 0xe06b40],
  },
  {
    name: "aurora",
    palette: [0x0a0820, 0x1a3060, 0x3878d8, 0x9adef8, 0xffe8a0, 0x14184a, 0x2a5db0, 0x60aaec],
  },
];

export const COLORWAY_COUNT = COLORWAYS.length;
