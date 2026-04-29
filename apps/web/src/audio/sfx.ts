export type SfxName = "playCard" | "takePile" | "win" | "lose" | "buttonHover" | "buttonClick";

export type SfxClip = (ctx: AudioContext, master: AudioNode, now: number) => void;

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

function tone(ctx: AudioContext, master: AudioNode, options: ToneOptions): void {
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
  gain.connect(master);
  osc.start(startTime);
  osc.stop(startTime + attack + release + 0.02);
}

const playCard: SfxClip = (ctx, master, now) => {
  tone(ctx, master, {
    type: "triangle",
    startFreq: 880,
    endFreq: 520,
    startTime: now,
    duration: 0.08,
    peakGain: 0.18,
    attack: 0.002,
    release: 0.09,
  });
  tone(ctx, master, {
    type: "square",
    startFreq: 1760,
    startTime: now,
    duration: 0.04,
    peakGain: 0.05,
    attack: 0.001,
    release: 0.04,
  });
};

const takePile: SfxClip = (ctx, master, now) => {
  tone(ctx, master, {
    type: "sine",
    startFreq: 220,
    endFreq: 110,
    startTime: now,
    duration: 0.22,
    peakGain: 0.28,
    attack: 0.004,
    release: 0.24,
  });
  tone(ctx, master, {
    type: "sine",
    startFreq: 110,
    endFreq: 70,
    startTime: now + 0.02,
    duration: 0.22,
    peakGain: 0.18,
    attack: 0.004,
    release: 0.26,
  });
};

const win: SfxClip = (ctx, master, now) => {
  tone(ctx, master, {
    type: "triangle",
    startFreq: 523.25,
    startTime: now,
    duration: 0.14,
    peakGain: 0.2,
    attack: 0.005,
    release: 0.16,
  });
  tone(ctx, master, {
    type: "triangle",
    startFreq: 659.25,
    startTime: now + 0.12,
    duration: 0.18,
    peakGain: 0.2,
    attack: 0.005,
    release: 0.22,
  });
  tone(ctx, master, {
    type: "triangle",
    startFreq: 783.99,
    startTime: now + 0.26,
    duration: 0.28,
    peakGain: 0.22,
    attack: 0.005,
    release: 0.32,
  });
};

const lose: SfxClip = (ctx, master, now) => {
  tone(ctx, master, {
    type: "sawtooth",
    startFreq: 392,
    startTime: now,
    duration: 0.18,
    peakGain: 0.14,
    attack: 0.005,
    release: 0.2,
  });
  tone(ctx, master, {
    type: "sawtooth",
    startFreq: 311.13,
    startTime: now + 0.16,
    duration: 0.32,
    peakGain: 0.16,
    attack: 0.005,
    release: 0.36,
  });
};

const buttonHover: SfxClip = (ctx, master, now) => {
  tone(ctx, master, {
    type: "sine",
    startFreq: 1400,
    startTime: now,
    duration: 0.025,
    peakGain: 0.06,
    attack: 0.002,
    release: 0.03,
  });
};

const buttonClick: SfxClip = (ctx, master, now) => {
  tone(ctx, master, {
    type: "square",
    startFreq: 880,
    endFreq: 660,
    startTime: now,
    duration: 0.05,
    peakGain: 0.12,
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
};
