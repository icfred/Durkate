export type RngState = readonly [number, number, number, number];

export interface Rng {
  readonly state: RngState;
  next(): number;
  nextFloat(): number;
  nextInt(maxExclusive: number): number;
  clone(): Rng;
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

function splitmix32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

export function createRng(seed: number): Rng {
  if (!Number.isInteger(seed)) {
    throw new TypeError("seed must be an integer");
  }
  const splitter = splitmix32(seed);
  let s0 = splitter();
  const s1 = splitter();
  const s2 = splitter();
  const s3 = splitter();
  // xoshiro is degenerate at all-zero state. Practically unreachable from
  // splitmix32, guarded for completeness.
  if ((s0 | s1 | s2 | s3) === 0) {
    s0 = 1;
  }
  return makeRng([s0, s1, s2, s3]);
}

export function rngFromState(state: RngState): Rng {
  const s0 = state[0] >>> 0;
  const s1 = state[1] >>> 0;
  const s2 = state[2] >>> 0;
  const s3 = state[3] >>> 0;
  // xoshiro is degenerate at all-zero state. A valid snapshot from createRng
  // can never produce this, so reject it as a corrupted input.
  if ((s0 | s1 | s2 | s3) === 0) {
    throw new RangeError("rng state must not be all zero");
  }
  return makeRng([s0, s1, s2, s3]);
}

function makeRng(initial: [number, number, number, number]): Rng {
  const s = initial;
  const next = (): number => {
    const result = Math.imul(rotl(Math.imul(s[1], 5) >>> 0, 7), 9) >>> 0;
    const t = (s[1] << 9) >>> 0;
    s[2] = (s[2] ^ s[0]) >>> 0;
    s[3] = (s[3] ^ s[1]) >>> 0;
    s[1] = (s[1] ^ s[2]) >>> 0;
    s[0] = (s[0] ^ s[3]) >>> 0;
    s[2] = (s[2] ^ t) >>> 0;
    s[3] = rotl(s[3], 11);
    return result;
  };
  return {
    get state(): RngState {
      return [s[0], s[1], s[2], s[3]];
    },
    next,
    nextFloat: () => next() / 0x1_0000_0000,
    nextInt: (maxExclusive: number): number => {
      if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
        throw new RangeError("maxExclusive must be a positive integer");
      }
      const range = 0x1_0000_0000;
      const limit = range - (range % maxExclusive);
      let r = next();
      while (r >= limit) {
        r = next();
      }
      return r % maxExclusive;
    },
    clone: () => makeRng([s[0], s[1], s[2], s[3]]),
  };
}
