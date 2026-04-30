import { Ticker } from "pixi.js";
import { describe, expect, it, vi } from "vitest";
import { type Anim, parallel, sequence } from "./compose.js";
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

describe("sequence", () => {
  it("runs anims in order, completing the next only after the previous finishes", () => {
    const clock = makeClock();
    const ticker = new Ticker();
    const log: string[] = [];

    const step = (label: string, durationMs: number): Anim => {
      return (done) =>
        tween({
          from: 0,
          to: 1,
          durationMs,
          onUpdate: () => {},
          onComplete: () => {
            log.push(label);
            done();
          },
          ticker,
          now: clock.now,
        });
    };

    const onComplete = vi.fn();
    sequence([step("a", 100), step("b", 100)], onComplete);

    clock.advance(100);
    ticker.update();
    expect(log).toEqual(["a"]);
    expect(onComplete).not.toHaveBeenCalled();

    clock.advance(100);
    ticker.update();
    expect(log).toEqual(["a", "b"]);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("cancel halts the running child and prevents further anims", () => {
    const clock = makeClock();
    const ticker = new Ticker();
    const log: string[] = [];
    const second = vi.fn();

    const handle = sequence([
      (done) =>
        tween({
          from: 0,
          to: 1,
          durationMs: 100,
          onUpdate: () => {},
          onComplete: () => {
            log.push("first");
            done();
          },
          ticker,
          now: clock.now,
        }),
      second,
    ]);

    handle.cancel();
    clock.advance(200);
    ticker.update();

    expect(log).toEqual([]);
    expect(second).not.toHaveBeenCalled();
  });

  it("empty list completes immediately", () => {
    const onComplete = vi.fn();
    sequence([], onComplete);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});

describe("parallel", () => {
  it("runs all anims concurrently and completes when the last one finishes", () => {
    const clock = makeClock();
    const ticker = new Ticker();
    const log: string[] = [];

    const step = (label: string, durationMs: number): Anim => {
      return (done) =>
        tween({
          from: 0,
          to: 1,
          durationMs,
          onUpdate: () => {},
          onComplete: () => {
            log.push(label);
            done();
          },
          ticker,
          now: clock.now,
        });
    };

    const onComplete = vi.fn();
    parallel([step("short", 100), step("long", 200)], onComplete);

    clock.advance(100);
    ticker.update();
    expect(log).toEqual(["short"]);
    expect(onComplete).not.toHaveBeenCalled();

    clock.advance(100);
    ticker.update();
    expect(log).toEqual(["short", "long"]);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("cancel halts all running children", () => {
    const clock = makeClock();
    const ticker = new Ticker();
    const onUpdateA = vi.fn();
    const onUpdateB = vi.fn();
    const onComplete = vi.fn();

    const handle = parallel(
      [
        () =>
          tween({
            from: 0,
            to: 1,
            durationMs: 100,
            onUpdate: onUpdateA,
            ticker,
            now: clock.now,
          }),
        () =>
          tween({
            from: 0,
            to: 1,
            durationMs: 100,
            onUpdate: onUpdateB,
            ticker,
            now: clock.now,
          }),
      ],
      onComplete,
    );

    clock.advance(50);
    ticker.update();
    handle.cancel();
    clock.advance(100);
    ticker.update();

    expect(onUpdateA).toHaveBeenCalledTimes(1);
    expect(onUpdateB).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("empty list completes immediately", () => {
    const onComplete = vi.fn();
    parallel([], onComplete);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
