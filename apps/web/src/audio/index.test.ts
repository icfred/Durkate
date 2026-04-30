import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appStore } from "../store.js";
import { __resetAudioForTests, playSfx } from "./index.js";
import { SFX_NAMES } from "./sfx.js";

interface FakeOscillator {
  type: OscillatorType;
  frequency: {
    setValueAtTime(value: number, time: number): void;
    exponentialRampToValueAtTime(value: number, time: number): void;
  };
  connect(node: unknown): void;
  start(time: number): void;
  stop(time: number): void;
}

interface FakeGain {
  gain: {
    value: number;
    setValueAtTime(value: number, time: number): void;
    linearRampToValueAtTime(value: number, time: number): void;
    exponentialRampToValueAtTime(value: number, time: number): void;
  };
  connect(node: unknown): void;
  disconnect(): void;
}

interface FakeBiquad {
  type: BiquadFilterType;
  frequency: { value: number };
  Q: { value: number };
  connect(node: unknown): void;
  disconnect(): void;
}

interface FakeShaper {
  curve: Float32Array | null;
  oversample: OverSampleType;
  connect(node: unknown): void;
  disconnect(): void;
}

interface FakeScriptProcessor {
  onaudioprocess: ((event: unknown) => void) | null;
  connect(node: unknown): void;
  disconnect(): void;
}

interface FakeAudioBuffer {
  getChannelData(channel: number): Float32Array;
}

interface FakeBufferSource {
  buffer: FakeAudioBuffer | null;
  loop: boolean;
  connect(node: unknown): void;
  disconnect(): void;
  start(time: number): void;
  stop(): void;
}

class FakeAudioContext {
  static created = 0;
  static oscillatorsStarted = 0;
  static gains = 0;
  static biquads = 0;
  static shapers = 0;
  static scriptProcessors = 0;
  static bufferSources = 0;

  state: AudioContextState = "running";
  currentTime = 0;
  sampleRate = 48000;
  destination = {} as AudioDestinationNode;

  constructor() {
    FakeAudioContext.created += 1;
  }

  createOscillator(): FakeOscillator {
    return {
      type: "sine",
      frequency: {
        setValueAtTime: () => {},
        exponentialRampToValueAtTime: () => {},
      },
      connect: () => {},
      start: () => {
        FakeAudioContext.oscillatorsStarted += 1;
      },
      stop: () => {},
    };
  }

  createGain(): FakeGain {
    FakeAudioContext.gains += 1;
    return {
      gain: {
        value: 1,
        setValueAtTime: () => {},
        linearRampToValueAtTime: () => {},
        exponentialRampToValueAtTime: () => {},
      },
      connect: () => {},
      disconnect: () => {},
    };
  }

  createBiquadFilter(): FakeBiquad {
    FakeAudioContext.biquads += 1;
    return {
      type: "lowpass",
      frequency: { value: 0 },
      Q: { value: 0 },
      connect: () => {},
      disconnect: () => {},
    };
  }

  createWaveShaper(): FakeShaper {
    FakeAudioContext.shapers += 1;
    return {
      curve: null,
      oversample: "none",
      connect: () => {},
      disconnect: () => {},
    };
  }

  createScriptProcessor(_buf: number, _inCh: number, _outCh: number): FakeScriptProcessor {
    FakeAudioContext.scriptProcessors += 1;
    return {
      onaudioprocess: null,
      connect: () => {},
      disconnect: () => {},
    };
  }

  createBuffer(_channels: number, length: number, _rate: number): FakeAudioBuffer {
    return {
      getChannelData: () => new Float32Array(length),
    };
  }

  createBufferSource(): FakeBufferSource {
    FakeAudioContext.bufferSources += 1;
    return {
      buffer: null,
      loop: false,
      connect: () => {},
      disconnect: () => {},
      start: () => {},
      stop: () => {},
    };
  }

  resume(): Promise<void> {
    this.state = "running";
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function setWindow(win: object | undefined): void {
  if (win === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    (globalThis as { window?: unknown }).window = win;
  }
}

function resetCounters(): void {
  FakeAudioContext.created = 0;
  FakeAudioContext.oscillatorsStarted = 0;
  FakeAudioContext.gains = 0;
  FakeAudioContext.biquads = 0;
  FakeAudioContext.shapers = 0;
  FakeAudioContext.scriptProcessors = 0;
  FakeAudioContext.bufferSources = 0;
}

describe("playSfx", () => {
  beforeEach(() => {
    resetCounters();
    setWindow({ AudioContext: FakeAudioContext });
    __resetAudioForTests();
    appStore.getState().setMuted(false);
  });

  afterEach(() => {
    appStore.getState().setMuted(false);
    __resetAudioForTests();
    setWindow(undefined);
  });

  it("synthesises a clip when not muted", () => {
    expect(playSfx("playCard")).toBe(true);
    expect(FakeAudioContext.created).toBe(1);
    expect(FakeAudioContext.oscillatorsStarted).toBeGreaterThan(0);
  });

  it("constructs the crusher chain on first playSfx", () => {
    expect(playSfx("playCard")).toBe(true);
    expect(FakeAudioContext.biquads).toBe(1);
    expect(FakeAudioContext.shapers).toBe(1);
    expect(FakeAudioContext.scriptProcessors).toBe(1);
  });

  it("is a no-op when muted and never creates an AudioContext", () => {
    appStore.getState().setMuted(true);
    expect(playSfx("playCard")).toBe(false);
    expect(playSfx("buttonClick")).toBe(false);
    expect(FakeAudioContext.created).toBe(0);
    expect(FakeAudioContext.oscillatorsStarted).toBe(0);
  });

  it("returns false silently when no AudioContext is available", () => {
    setWindow(undefined);
    __resetAudioForTests();
    expect(playSfx("playCard")).toBe(false);
  });

  it("plays each named clip without throwing", () => {
    for (const name of SFX_NAMES) {
      expect(playSfx(name)).toBe(true);
    }
    expect(FakeAudioContext.created).toBe(1);
  });
});
