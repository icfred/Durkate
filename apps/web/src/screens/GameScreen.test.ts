import type { Action, Card, Event } from "@durak/engine";
import type { Snapshot } from "@durak/protocol";
import type { Container, Text } from "pixi.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as anim from "../anim/index.js";
import * as audio from "../audio/index.js";
import { appStore } from "../store.js";
import { GameScreen } from "./GameScreen.js";
import { loadFixture } from "./sandboxFixtures.js";

vi.mock("../audio/index.js", () => ({
  playSfx: vi.fn().mockReturnValue(true),
  attachFocusNavSfx: vi.fn().mockReturnValue(() => {}),
}));

vi.mock("../anim/index.js", async () => {
  const actual = await vi.importActual<typeof import("../anim/index.js")>("../anim/index.js");
  return {
    ...actual,
    moveTo: vi.fn(actual.moveTo),
    fadeTo: vi.fn(actual.fadeTo),
    scaleTo: vi.fn(actual.scaleTo),
    sequence: vi.fn(actual.sequence),
    parallel: vi.fn(actual.parallel),
  };
});

const playSfxMock = vi.mocked(audio.playSfx);
const moveToMock = vi.mocked(anim.moveTo);
const fadeToMock = vi.mocked(anim.fadeTo);
const parallelMock = vi.mocked(anim.parallel);

function findByLabel(container: Container, label: string): Container | undefined {
  for (const child of container.children) {
    const c = child as Container;
    if (c.label === label) return c;
    const inner = findByLabel(c, label);
    if (inner) return inner;
  }
  return undefined;
}

const press = (key: string): KeyboardEvent =>
  new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });

describe("GameScreen", () => {
  it("shows a waiting placeholder when snapshot is null", () => {
    const screen = new GameScreen({ snapshot: null, submitAction: vi.fn() });
    screen.layout(800, 600);

    expect(findByLabel(screen, "opponent-layer")?.visible).toBe(false);
    expect(findByLabel(screen, "table")?.visible).toBe(false);
    expect(findByLabel(screen, "talon")?.visible).toBe(false);
    expect(findByLabel(screen, "discard")?.visible).toBe(false);
    expect(findByLabel(screen, "my-hand")?.visible).toBe(false);

    screen.dispose();
  });

  it("renders all sections from a fresh-deal snapshot", () => {
    const snapshot = loadFixture("fresh");
    const screen = new GameScreen({ snapshot, submitAction: vi.fn() });
    screen.layout(800, 600);

    const opponent = findByLabel(screen, "opponent-hand");
    const table = findByLabel(screen, "table");
    const talon = findByLabel(screen, "talon");
    const discard = findByLabel(screen, "discard");
    const myHand = findByLabel(screen, "my-hand");

    expect(opponent?.children.length).toBe(snapshot.handCounts[1]);
    expect(table?.children.length).toBe(0);
    expect((talon?.children.length ?? 0) > 0).toBe(true);
    expect((discard?.children.length ?? 0) > 0).toBe(true);
    expect(myHand?.children.length).toBe(snapshot.you.hand.length);

    screen.dispose();
  });

  it("submits a legal ATTACK on Enter from a fresh-deal snapshot", () => {
    const snapshot = loadFixture("fresh");
    const submitAction = vi.fn<(action: Action) => void>();
    const screen = new GameScreen({ snapshot, submitAction });
    screen.layout(800, 600);

    window.dispatchEvent(press("Enter"));

    expect(submitAction).toHaveBeenCalledTimes(1);
    const action = submitAction.mock.calls[0]?.[0];
    expect(action?.type).toBe("ATTACK");
    if (action?.type === "ATTACK") {
      expect(action.by).toBe(snapshot.seat);
      expect(action.card).toEqual(snapshot.you.hand[0]);
    }

    screen.dispose();
  });

  it("ArrowRight changes which card is played on Enter", () => {
    const snapshot = loadFixture("fresh");
    const submitAction = vi.fn<(action: Action) => void>();
    const screen = new GameScreen({ snapshot, submitAction });
    screen.layout(800, 600);

    window.dispatchEvent(press("ArrowRight"));
    window.dispatchEvent(press("Enter"));

    const action = submitAction.mock.calls[0]?.[0];
    expect(action?.type).toBe("ATTACK");
    if (action?.type === "ATTACK") {
      expect(action.card).toEqual(snapshot.you.hand[1]);
    }

    screen.dispose();
  });

  it("T submits TAKE_PILE for the seat", () => {
    const snapshot = loadFixture("takepile");
    const submitAction = vi.fn<(action: Action) => void>();
    const screen = new GameScreen({ snapshot, submitAction });
    screen.layout(800, 600);

    window.dispatchEvent(press("T"));

    expect(submitAction).toHaveBeenCalledWith({ type: "TAKE_PILE", by: snapshot.seat });

    screen.dispose();
  });

  it("E submits END_ROUND for the seat", () => {
    const snapshot = loadFixture("midround");
    const submitAction = vi.fn<(action: Action) => void>();
    const screen = new GameScreen({ snapshot, submitAction });
    screen.layout(800, 600);

    window.dispatchEvent(press("E"));

    expect(submitAction).toHaveBeenCalledWith({ type: "END_ROUND", by: snapshot.seat });

    screen.dispose();
  });

  it("renders the trump card under the talon when trump is face-up", () => {
    const snapshot = loadFixture("fresh");
    const screen = new GameScreen({ snapshot, submitAction: vi.fn() });
    screen.layout(800, 600);

    const talon = findByLabel(screen, "talon");
    const trumpCard = talon?.children.find((c) => (c as Container).label === "trump-card") as
      | Container
      | undefined;
    const badge = talon?.children.find((c) => (c as Container).label === "trump-badge") as
      | Container
      | undefined;

    expect(trumpCard).toBeDefined();
    expect(badge).toBeUndefined();

    screen.dispose();
  });

  it("renders a trump-suit badge in place of the card once the trump has been drawn", () => {
    const snapshot = loadFixture("trumpdrawn");
    expect(snapshot.trump).toBeNull();

    const screen = new GameScreen({ snapshot, submitAction: vi.fn() });
    screen.layout(800, 600);

    const talon = findByLabel(screen, "talon");
    const trumpCard = talon?.children.find((c) => (c as Container).label === "trump-card") as
      | Container
      | undefined;
    const badge = talon?.children.find((c) => (c as Container).label === "trump-badge") as
      | Container
      | undefined;

    expect(trumpCard).toBeUndefined();
    expect(badge).toBeDefined();

    screen.dispose();
  });

  it("renders Your turn — attack and the attack key hint on a fresh-deal snapshot", () => {
    const snapshot = loadFixture("fresh");
    const screen = new GameScreen({ snapshot, submitAction: vi.fn() });
    screen.layout(800, 600);

    const turn = findByLabel(screen, "turn-label") as Text | undefined;
    const hint = findByLabel(screen, "key-hint") as Text | undefined;
    expect(turn?.text).toBe("Your turn — attack");
    expect(hint?.text).toBe("Arrow keys: select  •  Enter: attack  •  M: mute");

    const myHand = findByLabel(screen, "my-hand");
    for (const view of myHand?.children ?? []) {
      expect((view as Container).alpha).toBe(1);
    }

    screen.dispose();
  });

  it("renders Your turn — defend and only beating cards stay full opacity", () => {
    const snapshot = loadFixture("midround");
    const screen = new GameScreen({ snapshot, submitAction: vi.fn() });
    screen.layout(800, 600);

    const turn = findByLabel(screen, "turn-label") as Text | undefined;
    const hint = findByLabel(screen, "key-hint") as Text | undefined;
    expect(turn?.text).toBe("Your turn — defend");
    expect(hint?.text).toBe("Arrow keys: select  •  Enter: defend  •  T: take pile  •  M: mute");

    const myHand = findByLabel(screen, "my-hand");
    const alphas = (myHand?.children ?? []).map((c) => (c as Container).alpha);
    // hand: clubs J (beats clubs 8), hearts 9 (trump beats), diamonds 13 (illegal)
    expect(alphas[0]).toBe(1);
    expect(alphas[1]).toBe(1);
    expect(alphas[2]).toBeLessThan(1);

    screen.dispose();
  });

  it("renders Your turn — throw in or pass when attacker has cards left after the bot defends", () => {
    const snapshot: Snapshot = {
      phase: "in-round",
      playerCount: 2,
      handCounts: [3, 5],
      talonCount: 18,
      trump: { suit: "hearts", rank: 6 },
      trumpSuit: "hearts",
      table: [
        {
          attack: { suit: "spades", rank: 8 },
          defense: { suit: "spades", rank: 12 },
        },
      ],
      attacker: 0,
      defender: 1,
      discard: [],
      seat: 0,
      you: {
        seat: 0,
        hand: [
          { suit: "clubs", rank: 8 } as Card,
          { suit: "diamonds", rank: 14 } as Card,
          { suit: "hearts", rank: 11 } as Card,
        ],
      },
    };
    const screen = new GameScreen({ snapshot, submitAction: vi.fn() });
    screen.layout(800, 600);

    expect((findByLabel(screen, "turn-label") as Text | undefined)?.text).toBe(
      "Your turn — throw in or pass",
    );
    expect((findByLabel(screen, "key-hint") as Text | undefined)?.text).toBe(
      "Arrow keys: select  •  Enter: throw in  •  E: end round  •  M: mute",
    );

    const myHand = findByLabel(screen, "my-hand");
    const alphas = (myHand?.children ?? []).map((c) => (c as Container).alpha);
    // clubs 8 throws in (rank on table), diamonds 14 / hearts 11 do not
    expect(alphas[0]).toBe(1);
    expect(alphas[1]).toBeLessThan(1);
    expect(alphas[2]).toBeLessThan(1);

    screen.dispose();
  });

  it("renders Opponent's turn when defender has beaten all attacks and attacker has the next move", () => {
    // 2-player: seat is the defender, every attack is already beaten,
    // so the attacker is the only one who can throw in or end the round.
    const snapshot: Snapshot = {
      phase: "in-round",
      playerCount: 2,
      handCounts: [4, 4],
      talonCount: 16,
      trump: { suit: "hearts", rank: 6 },
      trumpSuit: "hearts",
      table: [
        {
          attack: { suit: "spades", rank: 7 },
          defense: { suit: "spades", rank: 9 },
        },
      ],
      attacker: 0,
      defender: 1,
      discard: [],
      seat: 1,
      you: {
        seat: 1,
        hand: [{ suit: "clubs", rank: 9 } as Card],
      },
    };
    const screen = new GameScreen({ snapshot, submitAction: vi.fn() });
    screen.layout(800, 600);

    expect((findByLabel(screen, "turn-label") as Text | undefined)?.text).toBe("Opponent's turn");

    screen.dispose();
  });

  it("DEFEND with a non-beating card is blocked client-side", () => {
    const snapshot = loadFixture("midround");
    const submitAction = vi.fn<(action: Action) => void>();
    const screen = new GameScreen({ snapshot, submitAction });
    screen.layout(800, 600);

    // diamonds 13 cannot beat clubs 8 (different suit, not trump): no action.
    window.dispatchEvent(press("ArrowRight"));
    window.dispatchEvent(press("ArrowRight"));
    window.dispatchEvent(press("Enter"));
    expect(submitAction).not.toHaveBeenCalled();

    screen.dispose();
  });

  it("plays actionError when lastError surfaces", () => {
    type ErrorListener = (error: import("../store.js").ServerError | null) => void;
    const listeners: ErrorListener[] = [];
    const snapshot = loadFixture("fresh");
    const screen = new GameScreen({
      snapshot,
      submitAction: vi.fn(),
      subscribeError: (listener) => {
        listeners.push(listener);
        return () => {
          const idx = listeners.indexOf(listener);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
    });
    screen.layout(800, 600);

    playSfxMock.mockClear();
    for (const listener of listeners) {
      listener({ code: "DOES_NOT_BEAT", message: "card does not beat", seq: 1 });
    }
    expect(playSfxMock).toHaveBeenCalledWith("actionError");

    playSfxMock.mockClear();
    for (const listener of listeners) listener(null);
    expect(playSfxMock).not.toHaveBeenCalledWith("actionError");

    screen.dispose();
  });

  it("renders the disconnect banner with a countdown when room.disconnect is set", () => {
    type RoomListener = (room: import("../store.js").RoomMembership | null) => void;
    const listeners: RoomListener[] = [];
    const snapshot = loadFixture("fresh");
    const screen = new GameScreen({
      snapshot,
      submitAction: vi.fn(),
      subscribeRoom: (listener) => {
        listeners.push(listener);
        return () => {
          const idx = listeners.indexOf(listener);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
      now: () => 1_000_000,
    });
    screen.layout(800, 600);

    const banner = findByLabel(screen, "disconnect-banner");
    const text = banner?.children.find((c) => (c as Text).text !== undefined) as Text | undefined;
    expect(banner?.visible).toBe(false);

    for (const listener of listeners) {
      listener({
        seats: [{ name: "alice" }, { name: "bob" }],
        you: 0,
        rematchRequested: [],
        disconnect: { seat: 1, forfeitAt: 1_000_000 + 12_000 },
        disconnects: [{ seat: 1, forfeitAt: 1_000_000 + 12_000 }],
        thinkingSeats: [],
        eliminated: [],
      });
    }
    expect(banner?.visible).toBe(true);
    expect(text?.text).toContain("12s");

    for (const listener of listeners) {
      listener({
        seats: [{ name: "alice" }, { name: "bob" }],
        you: 0,
        rematchRequested: [],
        disconnect: null,
        disconnects: [],
        thinkingSeats: [],
        eliminated: [],
      });
    }
    expect(banner?.visible).toBe(false);

    screen.dispose();
  });

  it("renders the thinking indicator when room.thinkingSeats names the opponent", () => {
    type RoomListener = (room: import("../store.js").RoomMembership | null) => void;
    const listeners: RoomListener[] = [];
    const snapshot = loadFixture("fresh");
    const screen = new GameScreen({
      snapshot,
      submitAction: vi.fn(),
      subscribeRoom: (listener) => {
        listeners.push(listener);
        return () => {
          const idx = listeners.indexOf(listener);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
    });
    screen.layout(800, 600);

    const label = findByLabel(screen, "thinking-1");
    expect(label?.visible).toBe(false);

    for (const listener of listeners) {
      listener({
        seats: [{ name: "Host" }, { name: "Bot" }],
        you: 0,
        rematchRequested: [],
        disconnect: null,
        disconnects: [],
        thinkingSeats: [1],
        eliminated: [],
      });
    }
    expect(label?.visible).toBe(true);

    for (const listener of listeners) {
      listener({
        seats: [{ name: "Host" }, { name: "Bot" }],
        you: 0,
        rematchRequested: [],
        disconnect: null,
        disconnects: [],
        thinkingSeats: [],
        eliminated: [],
      });
    }
    expect(label?.visible).toBe(false);

    screen.dispose();
  });

  it("renders an error toast when lastError changes", () => {
    type ErrorListener = (error: import("../store.js").ServerError | null) => void;
    const listeners: ErrorListener[] = [];
    const snapshot = loadFixture("fresh");
    const screen = new GameScreen({
      snapshot,
      submitAction: vi.fn(),
      subscribeError: (listener) => {
        listeners.push(listener);
        return () => {
          const idx = listeners.indexOf(listener);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
    });
    screen.layout(800, 600);

    const banner = findByLabel(screen, "error-banner");
    expect(banner?.visible).toBe(false);
    for (const listener of listeners) {
      listener({ code: "DOES_NOT_BEAT", message: "card does not beat", seq: 1 });
    }
    expect(banner?.visible).toBe(true);
    for (const listener of listeners) listener(null);
    expect(banner?.visible).toBe(false);

    screen.dispose();
  });

  it("re-renders when subscribe pushes a new snapshot", () => {
    const listeners: ((s: import("@durak/protocol").Snapshot | null) => void)[] = [];
    const screen = new GameScreen({
      snapshot: null,
      submitAction: vi.fn(),
      subscribe: (cb) => {
        listeners.push(cb);
        return () => {
          const idx = listeners.indexOf(cb);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
    });
    screen.layout(800, 600);

    const fresh = loadFixture("fresh");
    for (const listener of listeners) listener(fresh);

    expect(findByLabel(screen, "my-hand")?.children.length).toBe(fresh.you.hand.length);

    screen.dispose();
  });
});

describe("GameScreen N-player layout", () => {
  function countOpponentSlots(screen: GameScreen): number {
    const layer = findByLabel(screen, "opponent-layer");
    return layer?.children.length ?? 0;
  }

  for (const fixture of ["ffa-3", "ffa-4", "ffa-5", "ffa-6"] as const) {
    it(`renders the right number of opponent slots for ${fixture}`, () => {
      const snapshot = loadFixture(fixture);
      const screen = new GameScreen({ snapshot, submitAction: vi.fn() });
      screen.layout(1024, 720);
      expect(countOpponentSlots(screen)).toBe(snapshot.playerCount - 1);
      screen.dispose();
    });
  }

  it("renders the eliminated overlay when the room marks a seat out", () => {
    type RoomListener = (room: import("../store.js").RoomMembership | null) => void;
    const listeners: RoomListener[] = [];
    const snapshot = loadFixture("ffa-4");
    const screen = new GameScreen({
      snapshot,
      submitAction: vi.fn(),
      subscribeRoom: (listener) => {
        listeners.push(listener);
        return () => {
          const idx = listeners.indexOf(listener);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
    });
    screen.layout(1024, 720);

    for (const listener of listeners) {
      listener({
        seats: [{ name: "you" }, { name: "B1" }, { name: "B2" }, { name: "B3" }],
        you: 0,
        rematchRequested: [],
        disconnect: null,
        disconnects: [],
        thinkingSeats: [],
        eliminated: [2],
      });
    }
    expect(findByLabel(screen, "eliminated-2")?.visible).toBe(true);
    expect(findByLabel(screen, "eliminated-1")?.visible).toBe(false);
    screen.dispose();
  });
});

describe("GameScreen spectator mode", () => {
  it("renders the spectator banner when the user's hand is empty mid-round", () => {
    const snapshot = loadFixture("ffa-4");
    const spectated = { ...snapshot, you: { ...snapshot.you, hand: [] } };
    const screen = new GameScreen({ snapshot: spectated, submitAction: vi.fn() });
    screen.layout(1024, 720);
    expect(findByLabel(screen, "spectator-banner")?.visible).toBe(true);
    expect(findByLabel(screen, "my-hand")?.visible).toBe(false);
    screen.dispose();
  });

  it("gates submitAction while spectating", () => {
    const snapshot = loadFixture("ffa-4");
    const spectated = { ...snapshot, you: { ...snapshot.you, hand: [] } };
    const submitAction = vi.fn();
    const screen = new GameScreen({ snapshot: spectated, submitAction });
    screen.layout(1024, 720);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "T" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "E" }));
    expect(submitAction).not.toHaveBeenCalled();
    screen.dispose();
  });
});

describe("GameScreen SFX wiring", () => {
  let emit: ((events: Event[]) => void) | null = null;

  beforeEach(() => {
    playSfxMock.mockClear();
    emit = null;
  });

  afterEach(() => {
    playSfxMock.mockClear();
  });

  function makeScreen(snapshot = loadFixture("fresh")): GameScreen {
    return new GameScreen({
      snapshot,
      submitAction: vi.fn(),
      subscribeEvents: (listener) => {
        emit = listener;
        return () => {
          emit = null;
        };
      },
    });
  }

  it("plays playCard sfx on CARD_PLAYED", () => {
    const screen = makeScreen();
    emit?.([
      {
        type: "CARD_PLAYED",
        by: 0,
        role: "ATTACK",
        card: { suit: "spades", rank: 7 },
      },
    ]);

    expect(playSfxMock).toHaveBeenCalledTimes(1);
    expect(playSfxMock).toHaveBeenCalledWith("playCard");

    screen.dispose();
  });

  it("plays takePile sfx on PILE_TAKEN", () => {
    const screen = makeScreen();
    emit?.([
      {
        type: "PILE_TAKEN",
        by: 1,
        cards: [{ suit: "clubs", rank: 6 }],
        attacker: 0,
        defender: 1,
      },
    ]);

    expect(playSfxMock).toHaveBeenCalledTimes(1);
    expect(playSfxMock).toHaveBeenCalledWith("takePile");

    screen.dispose();
  });

  it("plays win sfx on GAME_OVER when durak is the opponent", () => {
    const snapshot = loadFixture("fresh"); // you.seat === 0
    const screen = makeScreen(snapshot);
    emit?.([{ type: "GAME_OVER", durak: 1 }]);

    expect(playSfxMock).toHaveBeenCalledTimes(1);
    expect(playSfxMock).toHaveBeenCalledWith("win");

    screen.dispose();
  });

  it("plays lose sfx on GAME_OVER when you are the durak", () => {
    const snapshot = loadFixture("fresh"); // you.seat === 0
    const screen = makeScreen(snapshot);
    emit?.([{ type: "GAME_OVER", durak: 0 }]);

    expect(playSfxMock).toHaveBeenCalledTimes(1);
    expect(playSfxMock).toHaveBeenCalledWith("lose");

    screen.dispose();
  });

  it("plays dealStart on GAME_STARTED", () => {
    const screen = makeScreen();
    emit?.([{ type: "GAME_STARTED", trump: { suit: "hearts", rank: 6 }, attacker: 0 }]);
    expect(playSfxMock).toHaveBeenCalledTimes(1);
    expect(playSfxMock).toHaveBeenCalledWith("dealStart");
    screen.dispose();
  });

  it("plays talonDraw on TALON_DRAWN", () => {
    const screen = makeScreen();
    emit?.([{ type: "TALON_DRAWN", by: 0, cards: [{ suit: "spades", rank: 7 }] }]);
    expect(playSfxMock).toHaveBeenCalledTimes(1);
    expect(playSfxMock).toHaveBeenCalledWith("talonDraw");
    screen.dispose();
  });

  it("plays roundEnd on ROUND_ENDED", () => {
    const screen = makeScreen();
    emit?.([{ type: "ROUND_ENDED", discarded: [], attacker: 1, defender: 0 }]);
    expect(playSfxMock).toHaveBeenCalledTimes(1);
    expect(playSfxMock).toHaveBeenCalledWith("roundEnd");
    screen.dispose();
  });

  it("plays no chime on GAME_OVER draw", () => {
    const screen = makeScreen();
    emit?.([{ type: "GAME_OVER", durak: null }]);

    expect(playSfxMock).not.toHaveBeenCalled();

    screen.dispose();
  });

  it("does not re-trigger sounds for already-handled events", () => {
    const screen = makeScreen();
    const cardPlayed: Event = {
      type: "CARD_PLAYED",
      by: 0,
      role: "ATTACK",
      card: { suit: "spades", rank: 7 },
    };
    emit?.([cardPlayed]);
    emit?.([
      {
        type: "PILE_TAKEN",
        by: 1,
        cards: [{ suit: "clubs", rank: 6 }],
        attacker: 0,
        defender: 1,
      },
    ]);

    expect(playSfxMock).toHaveBeenCalledTimes(2);
    expect(playSfxMock).toHaveBeenNthCalledWith(1, "playCard");
    expect(playSfxMock).toHaveBeenNthCalledWith(2, "takePile");

    screen.dispose();
  });

  it("handles a batch of events in order", () => {
    const screen = makeScreen();
    emit?.([
      {
        type: "CARD_PLAYED",
        by: 0,
        role: "ATTACK",
        card: { suit: "spades", rank: 7 },
      },
      {
        type: "CARD_PLAYED",
        by: 1,
        role: "DEFEND",
        card: { suit: "spades", rank: 8 },
        target: 0,
      },
      {
        type: "PILE_TAKEN",
        by: 1,
        cards: [
          { suit: "spades", rank: 7 },
          { suit: "spades", rank: 8 },
        ],
        attacker: 0,
        defender: 1,
      },
    ]);

    expect(playSfxMock.mock.calls.map((c) => c[0])).toEqual(["playCard", "playCard", "takePile"]);

    screen.dispose();
  });

  it("integrates with appStore.appendEvents through main.ts-style wiring", () => {
    appStore.getState().showMenu();
    const snapshot = loadFixture("fresh");
    const screen = new GameScreen({
      snapshot,
      submitAction: vi.fn(),
      subscribeEvents: (listener) =>
        appStore.subscribe((next, prev) => {
          const delta = next.eventsTotal - prev.eventsTotal;
          if (delta <= 0) return;
          listener(next.events.slice(-delta));
        }),
    });

    appStore.getState().appendEvents([
      {
        type: "CARD_PLAYED",
        by: 0,
        role: "ATTACK",
        card: { suit: "spades", rank: 7 },
      },
    ]);

    expect(playSfxMock).toHaveBeenCalledTimes(1);
    expect(playSfxMock).toHaveBeenCalledWith("playCard");

    appStore.getState().appendEvents([
      {
        type: "PILE_TAKEN",
        by: 1,
        cards: [{ suit: "spades", rank: 7 }],
        attacker: 0,
        defender: 1,
      },
    ]);

    expect(playSfxMock).toHaveBeenCalledTimes(2);
    expect(playSfxMock).toHaveBeenNthCalledWith(2, "takePile");

    screen.dispose();
    appStore.getState().showMenu();
  });

  it("calls playSfx regardless of muted state - muting is enforced inside playSfx", () => {
    appStore.getState().setMuted(true);
    const screen = makeScreen();
    emit?.([
      {
        type: "CARD_PLAYED",
        by: 0,
        role: "ATTACK",
        card: { suit: "spades", rank: 7 },
      },
    ]);

    expect(playSfxMock).toHaveBeenCalledTimes(1);
    expect(playSfxMock).toHaveBeenCalledWith("playCard");

    appStore.getState().setMuted(false);
    screen.dispose();
  });
});

describe("GameScreen animations", () => {
  beforeEach(() => {
    moveToMock.mockClear();
    fadeToMock.mockClear();
    parallelMock.mockClear();
    appStore.getState().setAnimSpeed(1);
  });

  afterEach(() => {
    moveToMock.mockClear();
    fadeToMock.mockClear();
    parallelMock.mockClear();
    appStore.getState().setAnimSpeed(1);
  });

  function makeAnimScreen(initial: Snapshot | null) {
    const snapshotListeners: ((s: Snapshot | null) => void)[] = [];
    const eventListeners: ((events: Event[]) => void)[] = [];
    const screen = new GameScreen({
      snapshot: initial,
      submitAction: vi.fn(),
      subscribe: (cb) => {
        snapshotListeners.push(cb);
        return () => {
          const idx = snapshotListeners.indexOf(cb);
          if (idx >= 0) snapshotListeners.splice(idx, 1);
        };
      },
      subscribeEvents: (cb) => {
        eventListeners.push(cb);
        return () => {
          const idx = eventListeners.indexOf(cb);
          if (idx >= 0) eventListeners.splice(idx, 1);
        };
      },
    });
    screen.layout(800, 600);
    const pushSnapshot = (s: Snapshot | null) => {
      for (const l of snapshotListeners) l(s);
    };
    const emitEvents = (events: Event[]) => {
      for (const l of eventListeners) l(events);
    };
    return { screen, pushSnapshot, emitEvents };
  }

  it("animSpeed=0 skips all animations", () => {
    appStore.getState().setAnimSpeed(0);
    const { screen, pushSnapshot, emitEvents } = makeAnimScreen(null);
    pushSnapshot(loadFixture("fresh"));
    moveToMock.mockClear();
    fadeToMock.mockClear();

    emitEvents([
      { type: "GAME_STARTED", trump: { suit: "hearts", rank: 6 }, attacker: 0 },
      {
        type: "CARD_PLAYED",
        by: 0,
        role: "ATTACK",
        card: { suit: "spades", rank: 7 },
      },
    ]);

    expect(moveToMock).not.toHaveBeenCalled();
    expect(fadeToMock).not.toHaveBeenCalled();

    screen.dispose();
  });

  it("triggers anim engine calls in order for deal → attack → defend → end-round", () => {
    const fresh = loadFixture("fresh");
    const attackCard: Card = { suit: "spades", rank: 7 };
    const defenseCard: Card = { suit: "spades", rank: 13 };

    const afterAttack: Snapshot = {
      ...fresh,
      handCounts: [5, 6],
      table: [{ attack: attackCard }],
      seat: 1,
      you: {
        seat: 1,
        hand: [
          { suit: "clubs", rank: 6 },
          { suit: "diamonds", rank: 7 },
          { suit: "spades", rank: 13 },
          { suit: "hearts", rank: 9 },
          { suit: "clubs", rank: 10 },
          { suit: "hearts", rank: 14 },
        ],
      },
    };
    const afterDefend: Snapshot = {
      ...afterAttack,
      handCounts: [5, 5],
      table: [{ attack: attackCard, defense: defenseCard }],
      you: { ...afterAttack.you, hand: afterAttack.you.hand.slice(0, 5) },
    };
    const afterRoundEnd: Snapshot = {
      ...afterDefend,
      handCounts: [6, 6],
      table: [],
      attacker: 1,
      defender: 0,
      discard: [attackCard, defenseCard],
    };

    const { screen, pushSnapshot, emitEvents } = makeAnimScreen(null);

    moveToMock.mockClear();
    fadeToMock.mockClear();
    parallelMock.mockClear();

    pushSnapshot(fresh);
    emitEvents([{ type: "GAME_STARTED", trump: { suit: "hearts", rank: 6 }, attacker: 0 }]);
    expect(moveToMock.mock.calls.length).toBe(12);
    expect(parallelMock).toHaveBeenCalledTimes(1);

    moveToMock.mockClear();
    fadeToMock.mockClear();
    parallelMock.mockClear();

    pushSnapshot(afterAttack);
    emitEvents([{ type: "CARD_PLAYED", by: 0, role: "ATTACK", card: attackCard }]);
    expect(moveToMock).toHaveBeenCalledTimes(1);
    expect(fadeToMock).toHaveBeenCalledTimes(1);
    expect(parallelMock).toHaveBeenCalledTimes(1);

    moveToMock.mockClear();
    fadeToMock.mockClear();
    parallelMock.mockClear();

    pushSnapshot(afterDefend);
    emitEvents([{ type: "CARD_PLAYED", by: 1, role: "DEFEND", card: defenseCard, target: 0 }]);
    expect(moveToMock).toHaveBeenCalledTimes(1);
    expect(fadeToMock).toHaveBeenCalledTimes(1);
    expect(parallelMock).toHaveBeenCalledTimes(1);

    moveToMock.mockClear();
    fadeToMock.mockClear();
    parallelMock.mockClear();

    pushSnapshot(afterRoundEnd);
    emitEvents([
      { type: "ROUND_ENDED", discarded: [attackCard, defenseCard], attacker: 1, defender: 0 },
    ]);
    // Two ghost cards (attack + defense) each get a moveTo and a fadeTo, all wrapped in parallel.
    expect(moveToMock).toHaveBeenCalledTimes(2);
    expect(fadeToMock).toHaveBeenCalledTimes(2);
    expect(parallelMock.mock.calls.length).toBeGreaterThan(0);

    screen.dispose();
  });

  it("cancels in-flight animations when a new snapshot arrives", () => {
    const fresh = loadFixture("fresh");
    const { screen, pushSnapshot, emitEvents } = makeAnimScreen(null);
    pushSnapshot(fresh);
    moveToMock.mockClear();
    fadeToMock.mockClear();

    emitEvents([{ type: "GAME_STARTED", trump: { suit: "hearts", rank: 6 }, attacker: 0 }]);
    expect(moveToMock.mock.calls.length).toBeGreaterThan(0);

    pushSnapshot({ ...fresh, talonCount: fresh.talonCount - 1 });
    moveToMock.mockClear();

    emitEvents([{ type: "TALON_DRAWN", by: 0, cards: [{ suit: "spades", rank: 7 }] }]);
    expect(moveToMock).toHaveBeenCalled();

    screen.dispose();
  });
});
