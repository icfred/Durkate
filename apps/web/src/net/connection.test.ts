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

    appStore.getState().showLobby({ mode: "friend", roomCode: "ABCD" });
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
    appStore.getState().showLobby({ mode: "friend", roomCode: "ABCD" });
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
    appStore.getState().showLobby({ mode: "friend", roomCode: "ABCD" });
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
    appStore.getState().showLobby({ mode: "friend", roomCode: "ABCD" });
    expect(conns).toHaveLength(1);
    // simulate game phase with same roomCode
    appStore.setState({ phase: "game" });
    expect(conns).toHaveLength(1);
    expect(conns[0]?.closed).toBe(false);
    stop();
  });
});
