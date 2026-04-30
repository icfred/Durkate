import type { BotDifficulty, InRoundState } from "@durak/engine";
import { beats, rngFromState } from "@durak/engine";

// Bot pacing: a pre-move "think" delay armed via the AlarmScheduler so the
// bot doesn't snap moves the instant it's its turn. The delay is bounded by
// [THINK_MIN_MS, THINK_MAX_MS] then scaled by the bot's difficulty. The base
// ms is derived deterministically from a *clone* of `state.rng` (engine
// purity per ADR-0003: the bot is a pure observer and must not mutate
// `state.rng` outside `step()`).
export const THINK_MIN_MS = 400;
export const THINK_MAX_MS = 1400;

// Complexity proxy: number of legal actions at saturation. More options →
// the bot reads as "thinking longer". Capped to keep the upper bound at
// THINK_MAX_MS regardless of unusually wide branching factors.
const COMPLEXITY_SATURATION = 10;

// Per-difficulty multipliers applied after the base delay is computed.
// Easy snaps faster; hard "card-counts" slower.
export const DIFFICULTY_SCALE: Record<BotDifficulty, number> = {
  easy: 0.7,
  medium: 1.0,
  hard: 1.2,
};

export interface ThinkBounds {
  readonly min: number;
  readonly max: number;
}

export const DEFAULT_THINK_BOUNDS: ThinkBounds = { min: THINK_MIN_MS, max: THINK_MAX_MS };

// Counts the legal action set for `seat` at this state. Coarse — it tracks
// the engine rules well enough that a bot opening with 6 cards looks busier
// than one defending against a single uncovered attack with one possible
// beat. Returns at least 1 so the complexity fraction is always defined.
export function countLegalActions(state: InRoundState, seat: number): number {
  const hand = state.hands[seat] ?? [];
  if (state.table.length === 0) {
    if (seat !== state.attacker) return 1;
    return Math.max(1, hand.length);
  }
  const undefendedIdx = state.table.findIndex((p) => !p.defense);
  if (undefendedIdx >= 0) {
    if (seat !== state.defender) return 1;
    const target = state.table[undefendedIdx];
    if (!target) return 1;
    const defends = hand.filter((c) => beats(c, target.attack, state.trumpSuit)).length;
    // TAKE_PILE is always legal here, plus one DEFEND per beating card.
    return 1 + defends;
  }
  if (seat !== state.attacker) return 1;
  const ranks = new Set<number>();
  for (const p of state.table) {
    ranks.add(p.attack.rank);
    if (p.defense) ranks.add(p.defense.rank);
  }
  const throwins = hand.filter((c) => ranks.has(c.rank)).length;
  // END_ROUND is always legal here, plus one THROW_IN per matching card.
  return 1 + throwins;
}

export interface ThinkDelayArgs {
  state: InRoundState;
  seat: number;
  difficulty: BotDifficulty;
  bounds?: ThinkBounds;
}

// Computes a deterministic-per-state delay in ms. Two factors blend the
// base value within [min, max]: the legal-action count and a single
// rng-derived jitter. The rng is *cloned* from `state.rng` so the engine's
// stream is untouched. With min === max === 0 the delay collapses to 0 (a
// useful test/dev override that bypasses pacing entirely).
export function computeThinkDelay(args: ThinkDelayArgs): number {
  const bounds = args.bounds ?? DEFAULT_THINK_BOUNDS;
  if (bounds.min <= 0 && bounds.max <= 0) return 0;
  const min = Math.max(0, Math.min(bounds.min, bounds.max));
  const max = Math.max(bounds.min, bounds.max);
  const span = max - min;
  const legal = countLegalActions(args.state, args.seat);
  const complexity = Math.min(1, Math.max(0, (legal - 1) / (COMPLEXITY_SATURATION - 1)));
  const jitter = rngFromState(args.state.rng).nextFloat();
  // 70% complexity-driven, 30% jitter — keeps within-difficulty variance
  // visible without letting the rng dominate the busy/idle distinction.
  const blended = 0.7 * complexity + 0.3 * jitter;
  const base = min + blended * span;
  const scaled = base * DIFFICULTY_SCALE[args.difficulty];
  // Re-clamp into the scaled envelope so float drift can't push outside.
  const lo = min * DIFFICULTY_SCALE[args.difficulty];
  const hi = max * DIFFICULTY_SCALE[args.difficulty];
  return Math.round(Math.max(lo, Math.min(hi, scaled)));
}

export function readThinkBoundsFromEnv(env: {
  BOT_THINK_MIN_MS?: string;
  BOT_THINK_MAX_MS?: string;
}): ThinkBounds {
  const a = parseNonNegInt(env.BOT_THINK_MIN_MS, THINK_MIN_MS);
  const b = parseNonNegInt(env.BOT_THINK_MAX_MS, THINK_MAX_MS);
  if (a > b) return { min: b, max: a };
  return { min: a, max: b };
}

function parseNonNegInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}
