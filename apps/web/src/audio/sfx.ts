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
  | "dealStart";

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

const playCard: SfxClip = (ctx, target, now) => {
  tone(ctx, target, {
    type: "square",
    startFreq: 760,
    endFreq: 360,
    startTime: now,
    duration: 0.06,
    peakGain: 0.22,
    attack: 0.001,
    release: 0.07,
  });
  tone(ctx, target, {
    type: "triangle",
    startFreq: 220,
    startTime: now,
    duration: 0.05,
    peakGain: 0.12,
    attack: 0.002,
    release: 0.05,
  });
};

const takePile: SfxClip = (ctx, target, now) => {
  tone(ctx, target, {
    type: "sawtooth",
    startFreq: 180,
    endFreq: 80,
    startTime: now,
    duration: 0.24,
    peakGain: 0.26,
    attack: 0.004,
    release: 0.26,
  });
  tone(ctx, target, {
    type: "triangle",
    startFreq: 90,
    endFreq: 55,
    startTime: now + 0.02,
    duration: 0.22,
    peakGain: 0.18,
    attack: 0.004,
    release: 0.28,
  });
};

const win: SfxClip = (ctx, target, now) => {
  tone(ctx, target, {
    type: "square",
    startFreq: 392,
    startTime: now,
    duration: 0.16,
    peakGain: 0.18,
    attack: 0.005,
    release: 0.18,
  });
  tone(ctx, target, {
    type: "square",
    startFreq: 523.25,
    startTime: now + 0.14,
    duration: 0.32,
    peakGain: 0.2,
    attack: 0.005,
    release: 0.34,
  });
};

const lose: SfxClip = (ctx, target, now) => {
  tone(ctx, target, {
    type: "sawtooth",
    startFreq: 311.13,
    startTime: now,
    duration: 0.2,
    peakGain: 0.16,
    attack: 0.005,
    release: 0.22,
  });
  tone(ctx, target, {
    type: "sawtooth",
    startFreq: 233.08,
    startTime: now + 0.18,
    duration: 0.36,
    peakGain: 0.18,
    attack: 0.005,
    release: 0.4,
  });
};

const buttonHover: SfxClip = (ctx, target, now) => {
  tone(ctx, target, {
    type: "square",
    startFreq: 1100,
    startTime: now,
    duration: 0.02,
    peakGain: 0.05,
    attack: 0.001,
    release: 0.025,
  });
};

const buttonClick: SfxClip = (ctx, target, now) => {
  tone(ctx, target, {
    type: "square",
    startFreq: 760,
    endFreq: 520,
    startTime: now,
    duration: 0.06,
    peakGain: 0.16,
    attack: 0.001,
    release: 0.07,
  });
};

const navMove: SfxClip = (ctx, target, now) => {
  tone(ctx, target, {
    type: "square",
    startFreq: 920,
    startTime: now,
    duration: 0.018,
    peakGain: 0.07,
    attack: 0.001,
    release: 0.022,
  });
};

const navConfirm: SfxClip = (ctx, target, now) => {
  tone(ctx, target, {
    type: "square",
    startFreq: 540,
    endFreq: 880,
    startTime: now,
    duration: 0.06,
    peakGain: 0.18,
    attack: 0.001,
    release: 0.08,
  });
  tone(ctx, target, {
    type: "triangle",
    startFreq: 220,
    startTime: now,
    duration: 0.04,
    peakGain: 0.1,
    attack: 0.001,
    release: 0.05,
  });
};

const navBack: SfxClip = (ctx, target, now) => {
  tone(ctx, target, {
    type: "square",
    startFreq: 620,
    endFreq: 280,
    startTime: now,
    duration: 0.07,
    peakGain: 0.14,
    attack: 0.001,
    release: 0.08,
  });
};

const actionError: SfxClip = (ctx, target, now) => {
  tone(ctx, target, {
    type: "sawtooth",
    startFreq: 280,
    startTime: now,
    duration: 0.08,
    peakGain: 0.18,
    attack: 0.002,
    release: 0.09,
  });
  tone(ctx, target, {
    type: "sawtooth",
    startFreq: 180,
    startTime: now + 0.07,
    duration: 0.14,
    peakGain: 0.16,
    attack: 0.002,
    release: 0.15,
  });
};

const roundEnd: SfxClip = (ctx, target, now) => {
  tone(ctx, target, {
    type: "sawtooth",
    startFreq: 520,
    endFreq: 140,
    startTime: now,
    duration: 0.32,
    peakGain: 0.16,
    attack: 0.004,
    release: 0.34,
  });
  tone(ctx, target, {
    type: "triangle",
    startFreq: 260,
    endFreq: 90,
    startTime: now + 0.04,
    duration: 0.34,
    peakGain: 0.12,
    attack: 0.005,
    release: 0.36,
  });
};

const talonDraw: SfxClip = (ctx, target, now) => {
  tone(ctx, target, {
    type: "triangle",
    startFreq: 1320,
    endFreq: 880,
    startTime: now,
    duration: 0.04,
    peakGain: 0.09,
    attack: 0.001,
    release: 0.05,
  });
  tone(ctx, target, {
    type: "square",
    startFreq: 440,
    startTime: now + 0.01,
    duration: 0.03,
    peakGain: 0.06,
    attack: 0.001,
    release: 0.04,
  });
};

const dealStart: SfxClip = (ctx, target, now) => {
  tone(ctx, target, {
    type: "sawtooth",
    startFreq: 110,
    endFreq: 70,
    startTime: now,
    duration: 0.4,
    peakGain: 0.22,
    attack: 0.008,
    release: 0.42,
  });
  tone(ctx, target, {
    type: "square",
    startFreq: 165,
    startTime: now + 0.04,
    duration: 0.18,
    peakGain: 0.1,
    attack: 0.005,
    release: 0.2,
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
];
