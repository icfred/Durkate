import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appStore } from "../store.js";
import { __resetAudioForTests, playSfx } from "./index.js";

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
}

class FakeAudioContext {
  static created = 0;
  static oscillatorsStarted = 0;

  state: AudioContextState = "running";
  currentTime = 0;
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
    return {
      gain: {
        value: 1,
        setValueAtTime: () => {},
        linearRampToValueAtTime: () => {},
        exponentialRampToValueAtTime: () => {},
      },
      connect: () => {},
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

describe("playSfx", () => {
  beforeEach(() => {
    FakeAudioContext.created = 0;
    FakeAudioContext.oscillatorsStarted = 0;
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
});
