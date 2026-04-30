import type { Action, bot } from "@durak/engine";
import type { Snapshot } from "@durak/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appStore } from "../store.js";
import { subscribeAutoplay } from "./autoplay.js";

type ChooseFn = typeof bot.choose;

const trumpSuit = "hearts" as const;

const mySeatSnapshot: Snapshot = {
  phase: "in-round",
  playerCount: 2,
  handCounts: [3, 4],
  talonCount: 10,
  trump: { suit: "hearts", rank: 6 },
  trumpSuit,
  table: [],
  attacker: 0,
  defender: 1,
  discard: [],
  seat: 0,
  you: {
    seat: 0,
    hand: [
      { suit: "spades", rank: 7 },
      { suit: "clubs", rank: 9 },
      { suit: "diamonds", rank: 10 },
    ],
  },
};

const opponentSeatSnapshot: Snapshot = {
  ...mySeatSnapshot,
  attacker: 1,
  defender: 0,
  seat: 0,
  you: { seat: 0, hand: mySeatSnapshot.you.hand },
};

describe("subscribeAutoplay", () => {
  let cleanup: () => void = () => {};
  let dispatched: Action[];
  let chooseFn: ChooseFn;
  let chooseSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dispatched = [];
    const action: Action = {
      type: "ATTACK",
      by: 0,
      card: { suit: "spades", rank: 7 },
    };
    chooseSpy = vi.fn(() => action);
    chooseFn = chooseSpy as unknown as ChooseFn;
    const submit: (action: Action) => void = (a) => {
      dispatched.push(a);
    };
    appStore.getState().showMenu();
    appStore.getState().setAutoplay(false);
    appStore.getState().setSnapshot(null);
    appStore.setState({ submitAction: submit });
  });

  afterEach(() => {
    cleanup();
    appStore.getState().setAutoplay(false);
  });

  it("does nothing while autoplay is off", () => {
    cleanup = subscribeAutoplay({ store: appStore, choose: chooseFn });
    appStore.getState().setSnapshot(mySeatSnapshot);
    expect(chooseSpy).not.toHaveBeenCalled();
    expect(dispatched).toHaveLength(0);
  });

  it("dispatches the bot's chosen action when autoplay is on and it is your turn", () => {
    appStore.getState().setAutoplay(true);
    cleanup = subscribeAutoplay({ store: appStore, choose: chooseFn });
    appStore.getState().setSnapshot(mySeatSnapshot);
    expect(chooseSpy).toHaveBeenCalledTimes(1);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toEqual({
      type: "ATTACK",
      by: 0,
      card: { suit: "spades", rank: 7 },
    });
  });

  it("does not act when it is the opponent's turn", () => {
    appStore.getState().setAutoplay(true);
    cleanup = subscribeAutoplay({ store: appStore, choose: chooseFn });
    appStore.getState().setSnapshot(opponentSeatSnapshot);
    expect(chooseSpy).not.toHaveBeenCalled();
  });

  it("dedupes repeat dispatches on the same snapshot", () => {
    appStore.getState().setAutoplay(true);
    cleanup = subscribeAutoplay({ store: appStore, choose: chooseFn });
    appStore.getState().setSnapshot(mySeatSnapshot);
    appStore.getState().setSnapshot(mySeatSnapshot);
    expect(chooseSpy).toHaveBeenCalledTimes(1);
  });

  it("re-arms after autoplay is toggled off and back on", () => {
    appStore.getState().setAutoplay(true);
    cleanup = subscribeAutoplay({ store: appStore, choose: chooseFn });
    appStore.getState().setSnapshot(mySeatSnapshot);
    appStore.getState().setAutoplay(false);
    appStore.getState().setAutoplay(true);
    expect(chooseSpy).toHaveBeenCalledTimes(2);
  });
});
