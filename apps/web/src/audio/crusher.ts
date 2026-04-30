export interface CrusherOptions {
  cutoffHz?: number;
  drive?: number;
  bits?: number;
  reduction?: number;
  noiseLevel?: number;
  outputGain?: number;
}

export interface Crusher {
  input: AudioNode;
  dispose(): void;
}

const DEFAULTS: Required<CrusherOptions> = {
  cutoffHz: 6000,
  drive: 0.35,
  bits: 8,
  reduction: 4,
  // The noise source is a continuous AudioBufferSourceNode wired into the
  // master path; with any non-zero level it plays as background static
  // whenever the audio context is alive. Default off — bit-crushing +
  // saturation already give the Papers Please grit. Opt in per-clip via
  // a custom crusher if you really want a tape-noise floor.
  noiseLevel: 0,
  outputGain: 1,
};

interface ScriptProcessorEvent {
  inputBuffer: { getChannelData(channel: number): Float32Array };
  outputBuffer: { getChannelData(channel: number): Float32Array };
}

interface ScriptProcessorNodeLike extends AudioNode {
  onaudioprocess: ((event: ScriptProcessorEvent) => void) | null;
}

interface CapableContext {
  createScriptProcessor?: (
    bufferSize: number,
    inChannels: number,
    outChannels: number,
  ) => ScriptProcessorNodeLike;
  createBuffer?: (channels: number, length: number, rate: number) => AudioBuffer;
  createBufferSource?: () => AudioBufferSourceNode;
  sampleRate?: number;
}

function makeDriveCurve(amount: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(new ArrayBuffer(n * 4));
  const k = Math.max(0, amount) * 50;
  for (let i = 0; i < n; i += 1) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return curve;
}

function tryDisconnect(node: { disconnect(): void } | null | undefined): void {
  if (!node) return;
  try {
    node.disconnect();
  } catch {
    // already disconnected; ignore
  }
}

export function createCrusher(
  ctx: AudioContext,
  destination: AudioNode,
  options: CrusherOptions = {},
): Crusher {
  const opts = { ...DEFAULTS, ...options };
  const created: { disconnect(): void }[] = [];
  const input = ctx.createGain();
  created.push(input);

  let head: AudioNode = input;

  const tryAppend = (factory: () => AudioNode | null): void => {
    let node: AudioNode | null = null;
    try {
      node = factory();
    } catch {
      node = null;
    }
    if (!node) return;
    head.connect(node);
    head = node;
    created.push(node);
  };

  tryAppend(() => {
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = opts.cutoffHz;
    filter.Q.value = 0.7;
    return filter;
  });

  tryAppend(() => {
    const shaper = ctx.createWaveShaper();
    shaper.curve = makeDriveCurve(opts.drive);
    shaper.oversample = "2x";
    return shaper;
  });

  tryAppend(() => {
    const c = ctx as unknown as CapableContext;
    if (typeof c.createScriptProcessor !== "function") return null;
    const processor = c.createScriptProcessor(256, 1, 1);
    const step = 2 ** (1 - opts.bits);
    let phase = 0;
    let last = 0;
    processor.onaudioprocess = (event) => {
      const input2 = event.inputBuffer.getChannelData(0);
      const output2 = event.outputBuffer.getChannelData(0);
      for (let i = 0; i < input2.length; i += 1) {
        if (phase % opts.reduction === 0) {
          const v = input2[i] ?? 0;
          last = step * Math.round(v / step);
        }
        output2[i] = last;
        phase += 1;
      }
    };
    return processor;
  });

  const output = ctx.createGain();
  output.gain.value = opts.outputGain;
  head.connect(output);
  output.connect(destination);
  created.push(output);

  let noise: AudioBufferSourceNode | null = null;
  let noiseGain: GainNode | null = null;
  if (opts.noiseLevel > 0) {
    const c = ctx as unknown as CapableContext;
    if (
      typeof c.createBuffer === "function" &&
      typeof c.createBufferSource === "function" &&
      typeof c.sampleRate === "number"
    ) {
      try {
        const length = Math.max(1, Math.floor(c.sampleRate * 1.5));
        const buffer = c.createBuffer(1, length, c.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
        const src = c.createBufferSource();
        src.buffer = buffer;
        src.loop = true;
        const gain = ctx.createGain();
        gain.gain.value = opts.noiseLevel;
        src.connect(gain);
        gain.connect(output);
        src.start(0);
        noise = src;
        noiseGain = gain;
      } catch {
        noise = null;
        noiseGain = null;
      }
    }
  }

  return {
    input,
    dispose(): void {
      if (noise) {
        try {
          noise.stop();
        } catch {
          // stop may throw if already stopped
        }
        tryDisconnect(noise);
      }
      tryDisconnect(noiseGain);
      for (const node of created) tryDisconnect(node);
    },
  };
}
