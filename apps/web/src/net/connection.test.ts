import type { Event } from "@durak/engine";
import type { Snapshot } from "@durak/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appStore } from "../store.js";
import { createConnectionController } from "./connection.js";
import type { ConnectionStatus, WsClientHandlers, WsConnection } from "./wsClient.js";

interface FakeConn extends WsConnection {
  closed: boolean;
  sent: unknown[];
  handlers: WsClientHandlers;
  roomId: string;
}

function makeFakeConnect() {
  const conns: FakeConn[] = [];
  const impl = (opts: {
    roomId: string;
    token: string;
    serverUrl: string;
    handlers: WsClientHandlers;
  }) => {
    const sent: unknown[] = [];
    const conn: FakeConn = {
      closed: false,
      sent,
      handlers: opts.handlers,
      roomId: opts.roomId,
      send: (msg) => sent.push(msg),
      close: () => {
        conn.closed = true;
      },
    };
    conns.push(conn);
    return conn;
  };
  return { conns, impl };
}

function status(s: ConnectionStatus): { status: ConnectionStatus; attempts: number } {
  return { status: s, attempts: 0 };
}

describe("createConnectionController", () => {
  let debug: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    appStore.getState().showMenu();
    appStore.getState().setConnectionStatus("idle", { attempts: 0 });
    appStore.getState().setSender(null);
    debug = vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    debug.mockRestore();
    appStore.getState().showMenu();
    appStore.getState().setSender(null);
    appStore.getState().setConnectionStatus("idle", { attempts: 0 });
  });

  it("opens a connection on transition to lobby and closes on return to menu", () => {
    const { conns, impl } = makeFakeConnect();
    const controller = createConnectionController({
      store: appStore,
      serverUrl: "ws://host/ws",
      connectImpl: impl,
    });
    const stop = controller.start();
    expect(conns).toHaveLength(0);

    appStore.getState().showLobby({ mode: "friend", roomCode: "ABCD", token: "test-token" });
    expect(conns).toHaveLength(1);
    expect(conns[0]?.roomId).toBe("ABCD");

    appStore.getState().showMenu();
    expect(conns[0]?.closed).toBe(true);
    stop();
  });

  it("forwards status changes from the wsClient into the store", () => {
    const { conns, impl } = makeFakeConnect();
    const controller = createConnectionController({
      store: appStore,
      serverUrl: "ws://host/ws",
      connectImpl: impl,
    });
    const stop = controller.start();
    appStore.getState().showLobby({ mode: "friend", roomCode: "ABCD", token: "test-token" });
    conns[0]?.handlers.onStatus("open", { attempts: 0 });
    expect(appStore.getState().connection).toEqual(status("open"));

    conns[0]?.handlers.onStatus("error", { attempts: 4, error: "boom" });
    expect(appStore.getState().connection).toEqual({
      status: "error",
      attempts: 4,
      error: "boom",
    });
    stop();
  });

  it("registers the wsClient's send as the store sender, then clears on close", () => {
    const { conns, impl } = makeFakeConnect();
    const controller = createConnectionController({
      store: appStore,
      serverUrl: "ws://host/ws",
      connectImpl: impl,
    });
    const stop = controller.start();
    appStore.getState().showLobby({ mode: "friend", roomCode: "ABCD", token: "test-token" });
    conns[0]?.handlers.onStatus("open", { attempts: 0 });
    appStore.getState().submitAction({ type: "START_GAME" });
    expect(conns[0]?.sent).toEqual([{ type: "SubmitAction", action: { type: "START_GAME" } }]);

    appStore.getState().showMenu();
    expect(conns[0]?.closed).toBe(true);
    // After close the sender slot is empty - submitAction drops.
    appStore.getState().setConnectionStatus("open", { attempts: 0 });
    appStore.getState().submitAction({ type: "START_GAME" });
    expect(conns[0]?.sent).toHaveLength(1);
    stop();
  });

  it("does not reopen when the same room reappears in lobby -> game", () => {
    const { conns, impl } = makeFakeConnect();
    const controller = createConnectionController({
      store: appStore,
      serverUrl: "ws://host/ws",
      connectImpl: impl,
    });
    const stop = controller.start();
    appStore.getState().showLobby({ mode: "friend", roomCode: "ABCD", token: "test-token" });
    expect(conns).toHaveLength(1);
    // simulate game phase with same roomCode
    appStore.setState({ phase: "game" });
    expect(conns).toHaveLength(1);
    expect(conns[0]?.closed).toBe(false);
    stop();
  });

  it("auto-transitions lobby -> game when the first snapshot arrives", () => {
    const { conns, impl } = makeFakeConnect();
    const controller = createConnectionController({
      store: appStore,
      serverUrl: "ws://host/ws",
      connectImpl: impl,
    });
    const stop = controller.start();
    appStore.getState().showLobby({ mode: "friend", roomCode: "ABCD", token: "test-token" });
    expect(appStore.getState().phase).toBe("lobby");

    conns[0]?.handlers.onSnapshot({ type: "Snapshot", snapshot: makeSnapshot(0) });
    expect(appStore.getState().phase).toBe("game");
    expect(appStore.getState().snapshot).not.toBeNull();
    stop();
  });

  it("auto-transitions game -> gameover when a GAME_OVER event arrives", () => {
    const { conns, impl } = makeFakeConnect();
    const controller = createConnectionController({
      store: appStore,
      serverUrl: "ws://host/ws",
      connectImpl: impl,
    });
    const stop = controller.start();
    appStore.getState().showLobby({ mode: "friend", roomCode: "ABCD", token: "test-token" });
    appStore.getState().setRoomMembership({
      seats: [{ name: "alice" }, { name: "bob" }],
      you: 1,
      rematchRequested: [],
      disconnect: null,
      disconnects: [],
      thinkingSeats: [],
      eliminated: [],
    });
    conns[0]?.handlers.onSnapshot({ type: "Snapshot", snapshot: makeSnapshot(1) });
    expect(appStore.getState().phase).toBe("game");

    const events: Event[] = [{ type: "GAME_OVER", durak: 0 }];
    conns[0]?.handlers.onEvents({ type: "Events", events });
    const state = appStore.getState();
    expect(state.phase).toBe("gameover");
    expect(state.gameover).toEqual({
      youSeat: 1,
      durak: 0,
      seatNames: ["alice", "bob"],
    });
    stop();
  });

  it("does not re-fire showGameOver if a second GAME_OVER event is observed", () => {
    const { conns, impl } = makeFakeConnect();
    const controller = createConnectionController({
      store: appStore,
      serverUrl: "ws://host/ws",
      connectImpl: impl,
    });
    const stop = controller.start();
    appStore.getState().showLobby({ mode: "friend", roomCode: "ABCD", token: "test-token" });
    conns[0]?.handlers.onSnapshot({ type: "Snapshot", snapshot: makeSnapshot(0) });

    const events: Event[] = [{ type: "GAME_OVER", durak: 1 }];
    conns[0]?.handlers.onEvents({ type: "Events", events });
    expect(appStore.getState().gameover).toEqual({ youSeat: 0, durak: 1 });

    // Mutate the gameover slot externally and resend; it must not be overwritten.
    appStore.getState().showGameOver({ youSeat: 0, durak: 1, seatNames: ["a", "b"] });
    conns[0]?.handlers.onEvents({ type: "Events", events });
    expect(appStore.getState().gameover?.seatNames).toEqual(["a", "b"]);
    stop();
  });

  it("reverts game -> lobby on connection close without a prior GAME_OVER", () => {
    const { conns, impl } = makeFakeConnect();
    const controller = createConnectionController({
      store: appStore,
      serverUrl: "ws://host/ws",
      connectImpl: impl,
    });
    const stop = controller.start();
    appStore.getState().showLobby({ mode: "friend", roomCode: "ABCD", token: "test-token" });
    conns[0]?.handlers.onSnapshot({ type: "Snapshot", snapshot: makeSnapshot(0) });
    expect(appStore.getState().phase).toBe("game");

    conns[0]?.handlers.onStatus("closed", { attempts: 1 });
    const state = appStore.getState();
    expect(state.phase).toBe("lobby");
    expect(state.mode).toBe("friend");
    expect(state.roomCode).toBe("ABCD");
    stop();
  });

  it("keeps gameover on connection close after a GAME_OVER event", () => {
    const { conns, impl } = makeFakeConnect();
    const controller = createConnectionController({
      store: appStore,
      serverUrl: "ws://host/ws",
      connectImpl: impl,
    });
    const stop = controller.start();
    appStore.getState().showLobby({ mode: "friend", roomCode: "ABCD", token: "test-token" });
    conns[0]?.handlers.onSnapshot({ type: "Snapshot", snapshot: makeSnapshot(0) });
    conns[0]?.handlers.onEvents({
      type: "Events",
      events: [{ type: "GAME_OVER", durak: null }],
    });
    expect(appStore.getState().phase).toBe("gameover");

    conns[0]?.handlers.onStatus("closed", { attempts: 1 });
    expect(appStore.getState().phase).toBe("gameover");
    stop();
  });

  it("populates room membership from RoomState messages", () => {
    const { conns, impl } = makeFakeConnect();
    const controller = createConnectionController({
      store: appStore,
      serverUrl: "ws://host/ws",
      connectImpl: impl,
    });
    const stop = controller.start();
    appStore.getState().showLobby({ mode: "friend", roomCode: "ABCD", token: "test-token" });
    conns[0]?.handlers.onRoomState({
      type: "RoomState",
      roomId: "ABCD",
      seats: [{ name: "alice" }, { name: null }],
      you: 0,
      rematchRequested: [],
    });
    expect(appStore.getState().room).toEqual({
      seats: [{ name: "alice" }, { name: null }],
      you: 0,
      rematchRequested: [],
      disconnect: null,
      disconnects: [],
      thinkingSeats: [],
      eliminated: [],
    });
    stop();
  });

  it("transitions gameover -> game when a fresh snapshot arrives (rematch)", () => {
    const { conns, impl } = makeFakeConnect();
    const controller = createConnectionController({
      store: appStore,
      serverUrl: "ws://host/ws",
      connectImpl: impl,
    });
    const stop = controller.start();
    appStore.getState().showLobby({ mode: "friend", roomCode: "ABCD", token: "test-token" });
    conns[0]?.handlers.onSnapshot({ type: "Snapshot", snapshot: makeSnapshot(0) });
    conns[0]?.handlers.onEvents({
      type: "Events",
      events: [{ type: "GAME_OVER", durak: 1 }],
    });
    expect(appStore.getState().phase).toBe("gameover");

    // Server fires a rematch and pushes a new in-round snapshot on the
    // same connection. The client must drop the gameover screen and
    // resume the game without reopening the socket.
    conns[0]?.handlers.onSnapshot({ type: "Snapshot", snapshot: makeSnapshot(0) });
    expect(appStore.getState().phase).toBe("game");
    expect(conns).toHaveLength(1);
    expect(conns[0]?.closed).toBe(false);
    stop();
  });
});

function makeSnapshot(youSeat: 0 | 1): Snapshot {
  return {
    phase: "in-round",
    playerCount: 2,
    handCounts: [6, 6],
    talonCount: 22,
    trump: { suit: "hearts", rank: 6 },
    trumpSuit: "hearts",
    table: [],
    attacker: 0,
    defender: 1,
    discard: [],
    seat: youSeat,
    you: { seat: youSeat, hand: [] },
  };
}
