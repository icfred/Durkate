export type SfxName =
  | "playCard"
  | "takePile"
  | "win"
  | "lose"
  | "buttonHover"
  | "buttonClick"
  | "navMove"
  | "navConfirm"
  | "navBack"
  | "actionError"
  | "roundEnd"
  | "talonDraw"
  | "dealStart"
  | "timerTick";

export type SfxClip = (ctx: AudioContext, target: AudioNode, now: number) => void;

interface ToneOptions {
  type: OscillatorType;
  startFreq: number;
  endFreq?: number;
  startTime: number;
  duration: number;
  peakGain: number;
  attack?: number;
  release?: number;
}

function tone(ctx: AudioContext, target: AudioNode, options: ToneOptions): void {
  const {
    type,
    startFreq,
    endFreq = startFreq,
    startTime,
    duration,
    peakGain,
    attack = 0.005,
    release = duration,
  } = options;

  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(startFreq, startTime);
  if (endFreq !== startFreq) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(endFreq, 1), startTime + duration);
  }

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(peakGain, startTime + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + attack + release);

  osc.connect(gain);
  gain.connect(target);
  osc.start(startTime);
  osc.stop(startTime + attack + release + 0.02);
}

// Tuning notes for the whole palette:
// - Frequencies dropped roughly a fourth-to-octave from the original
//   palette so the body sits in the warm 100-500 Hz band rather than
//   the harsh 600-1200 Hz band.
// - Square / sawtooth swapped for triangle on slow / sustained clips
//   (round outcomes, take-pile, dealStart) — triangle has far less
//   high-harmonic energy so it reads as "deep thump" rather than "buzz".
// - Square retained on the very short blip clips (nav, click, hover,
//   tick) so they keep their snappy attack — but pitched lower and
//   gain-reduced.
// - Peak gains pulled ~30-50% lower across the board on top of the
//   master-gain drop in `index.ts`. Stacks compounding so the final
//   loudness is meaningfully softer without losing the clip's shape.

const playCard: SfxClip = (ctx, target, now) => {
  tone(ctx, target, {
    type: "triangle",
    startFreq: 440,
    endFreq: 220,
    startTime: now,
    duration: 0.07,
    peakGain: 0.16,
    attack: 0.002,
    release: 0.08,
  });
  tone(ctx, target, {
    type: "sine",
    startFreq: 140,
    startTime: now,
    duration: 0.06,
    peakGain: 0.1,
    attack: 0.003,
    release: 0.06,
  });
};

const takePile: SfxClip = (ctx, target, now) => {
  tone(ctx, target, {
    type: "triangle",
    startFreq: 130,
    endFreq: 60,
    startTime: now,
    duration: 0.28,
    peakGain: 0.2,
    attack: 0.005,
    release: 0.3,
  });
  tone(ctx, target, {
    type: "sine",
    startFreq: 70,
    endFreq: 45,
    startTime: now + 0.02,
    duration: 0.26,
    peakGain: 0.16,
    attack: 0.005,
    release: 0.32,
  });
};

const win: SfxClip = (ctx, target, now) => {
  tone(ctx, target, {
    type: "triangle",
    startFreq: 262,
    startTime: now,
    duration: 0.18,
    peakGain: 0.14,
    attack: 0.006,
    release: 0.2,
  });
  tone(ctx, target, {
    type: "triangle",
    startFreq: 392,
    startTime: now + 0.16,
    duration: 0.36,
    peakGain: 0.16,
    attack: 0.006,
    release: 0.38,
  });
};

const lose: SfxClip = (ctx, target, now) => {
  tone(ctx, target, {
    type: "triangle",
    startFreq: 220,
    startTime: now,
    duration: 0.22,
    peakGain: 0.12,
    attack: 0.006,
    release: 0.24,
  });
  tone(ctx, target, {
    type: "triangle",
    startFreq: 165,
    startTime: now + 0.2,
    duration: 0.4,
    peakGain: 0.14,
    attack: 0.006,
    release: 0.44,
  });
};

const buttonHover: SfxClip = (ctx, target, now) => {
  tone(ctx, target, {
    type: "triangle",
    startFreq: 700,
    startTime: now,
    duration: 0.022,
    peakGain: 0.03,
    attack: 0.001,
    release: 0.026,
  });
};

const buttonClick: SfxClip = (ctx, target, now) => {
  tone(ctx, target, {
    type: "triangle",
    startFreq: 540,
    endFreq: 360,
    startTime: now,
    duration: 0.07,
    peakGain: 0.11,
    attack: 0.001,
    release: 0.08,
  });
};

const navMove: SfxClip = (ctx, target, now) => {
  tone(ctx, target, {
    type: "triangle",
    startFreq: 640,
    startTime: now,
    duration: 0.02,
    peakGain: 0.045,
    attack: 0.001,
    release: 0.024,
  });
};

const navConfirm: SfxClip = (ctx, target, now) => {
  tone(ctx, target, {
    type: "triangle",
    startFreq: 380,
    endFreq: 600,
    startTime: now,
    duration: 0.07,
    peakGain: 0.12,
    attack: 0.001,
    release: 0.09,
  });
  tone(ctx, target, {
    type: "sine",
    startFreq: 165,
    startTime: now,
    duration: 0.05,
    peakGain: 0.08,
    attack: 0.001,
    release: 0.06,
  });
};

const navBack: SfxClip = (ctx, target, now) => {
  tone(ctx, target, {
    type: "triangle",
    startFreq: 440,
    endFreq: 200,
    startTime: now,
    duration: 0.08,
    peakGain: 0.1,
    attack: 0.001,
    release: 0.09,
  });
};

const actionError: SfxClip = (ctx, target, now) => {
  tone(ctx, target, {
    type: "triangle",
    startFreq: 200,
    startTime: now,
    duration: 0.09,
    peakGain: 0.13,
    attack: 0.003,
    release: 0.1,
  });
  tone(ctx, target, {
    type: "triangle",
    startFreq: 130,
    startTime: now + 0.07,
    duration: 0.16,
    peakGain: 0.12,
    attack: 0.003,
    release: 0.18,
  });
};

const roundEnd: SfxClip = (ctx, target, now) => {
  tone(ctx, target, {
    type: "triangle",
    startFreq: 360,
    endFreq: 110,
    startTime: now,
    duration: 0.36,
    peakGain: 0.12,
    attack: 0.005,
    release: 0.38,
  });
  tone(ctx, target, {
    type: "sine",
    startFreq: 180,
    endFreq: 70,
    startTime: now + 0.04,
    duration: 0.38,
    peakGain: 0.1,
    attack: 0.006,
    release: 0.4,
  });
};

const talonDraw: SfxClip = (ctx, target, now) => {
  tone(ctx, target, {
    type: "triangle",
    startFreq: 720,
    endFreq: 520,
    startTime: now,
    duration: 0.045,
    peakGain: 0.06,
    attack: 0.001,
    release: 0.055,
  });
  tone(ctx, target, {
    type: "sine",
    startFreq: 320,
    startTime: now + 0.01,
    duration: 0.035,
    peakGain: 0.04,
    attack: 0.001,
    release: 0.045,
  });
};

const dealStart: SfxClip = (ctx, target, now) => {
  tone(ctx, target, {
    type: "triangle",
    startFreq: 90,
    endFreq: 55,
    startTime: now,
    duration: 0.44,
    peakGain: 0.18,
    attack: 0.01,
    release: 0.46,
  });
  tone(ctx, target, {
    type: "sine",
    startFreq: 130,
    startTime: now + 0.04,
    duration: 0.2,
    peakGain: 0.08,
    attack: 0.006,
    release: 0.22,
  });
};

// Short low-time clock tick. Plays once per second in the last 5s of a
// turn deadline. Triangle wave (was square) for a softer blip; the
// short envelope still keeps it from bleeding into the next tick.
const timerTick: SfxClip = (ctx, target, now) => {
  tone(ctx, target, {
    type: "triangle",
    startFreq: 600,
    startTime: now,
    duration: 0.07,
    peakGain: 0.05,
    attack: 0.002,
    release: 0.06,
  });
};

export const sfxClips: Record<SfxName, SfxClip> = {
  playCard,
  takePile,
  win,
  lose,
  buttonHover,
  buttonClick,
  navMove,
  navConfirm,
  navBack,
  actionError,
  roundEnd,
  talonDraw,
  dealStart,
  timerTick,
};

export const SFX_NAMES: readonly SfxName[] = [
  "playCard",
  "takePile",
  "win",
  "lose",
  "buttonHover",
  "buttonClick",
  "navMove",
  "navConfirm",
  "navBack",
  "actionError",
  "roundEnd",
  "talonDraw",
  "dealStart",
  "timerTick",
];
