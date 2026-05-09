import { Ticker } from "pixi.js";
import { describe, expect, it, vi } from "vitest";
import { easeInQuad, easeOutQuad } from "./easings.js";
import { tween } from "./tween.js";

function makeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 0;
  return {
    now: () => t,
    advance(ms) {
      t += ms;
    },
  };
}

describe("tween", () => {
  it("interpolates linearly given a fixed clock", () => {
    const clock = makeClock();
    const ticker = new Ticker();
    const samples: number[] = [];

    tween({
      from: 0,
      to: 100,
      durationMs: 1000,
      onUpdate: (v) => samples.push(v),
      ticker,
      now: clock.now,
    });

    clock.advance(250);
    ticker.update();
    clock.advance(250);
    ticker.update();
    clock.advance(500);
    ticker.update();

    expect(samples).toEqual([25, 50, 100]);
  });

  it("applies easing", () => {
    const clock = makeClock();
    const ticker = new Ticker();
    let last = -1;

    tween({
      from: 0,
      to: 1,
      durationMs: 1000,
      easing: easeInQuad,
      onUpdate: (v) => {
        last = v;
      },
      ticker,
      now: clock.now,
    });

    clock.advance(500);
    ticker.update();
    expect(last).toBeCloseTo(easeInQuad(0.5), 6);
  });

  it("calls onComplete exactly once and removes itself from the ticker", () => {
    const clock = makeClock();
    const ticker = new Ticker();
    const onComplete = vi.fn();
    const onUpdate = vi.fn();

    tween({
      from: 0,
      to: 10,
      durationMs: 100,
      onUpdate,
      onComplete,
      ticker,
      now: clock.now,
    });

    clock.advance(150);
    ticker.update();
    clock.advance(50);
    ticker.update();

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenLastCalledWith(10, 1);
  });

  it("cancel halts further updates and skips onComplete", () => {
    const clock = makeClock();
    const ticker = new Ticker();
    const onUpdate = vi.fn();
    const onComplete = vi.fn();

    const handle = tween({
      from: 0,
      to: 1,
      durationMs: 1000,
      easing: easeOutQuad,
      onUpdate,
      onComplete,
      ticker,
      now: clock.now,
    });

    clock.advance(250);
    ticker.update();
    expect(onUpdate).toHaveBeenCalledTimes(1);

    handle.cancel();

    clock.advance(1000);
    ticker.update();

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("durationMs <= 0 finishes synchronously at the target value", () => {
    const ticker = new Ticker();
    const onUpdate = vi.fn();
    const onComplete = vi.fn();

    tween({
      from: 0,
      to: 5,
      durationMs: 0,
      onUpdate,
      onComplete,
      ticker,
    });

    expect(onUpdate).toHaveBeenLastCalledWith(5, 1);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("speed() scales elapsed time", () => {
    const clock = makeClock();
    const ticker = new Ticker();
    const samples: number[] = [];

    tween({
      from: 0,
      to: 100,
      durationMs: 1000,
      onUpdate: (v) => samples.push(v),
      ticker,
      now: clock.now,
      speed: () => 2,
    });

    clock.advance(250);
    ticker.update();
    clock.advance(250);
    ticker.update();

    expect(samples).toEqual([50, 100]);
  });
});
