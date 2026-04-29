import type { StoreApi } from "zustand/vanilla";
import type { AppState } from "../store.js";
import { connect, type WsClientHandlers, type WsConnection } from "./wsClient.js";

export interface ConnectionControllerOptions {
  store: StoreApi<AppState>;
  serverUrl: string;
  /** Resolves the per-connection auth token. Stub returns "" until DUR-17 lands a real session. */
  resolveToken?: (roomId: string) => string;
  /** Test seam: replaces the underlying `connect` impl. */
  connectImpl?: typeof connect;
}

export interface ConnectionController {
  start(): () => void;
}

/**
 * Subscribes to `appStore.phase` and opens/closes a single websocket
 * connection in lockstep with the lobby/game/gameover lifecycle. Calls
 * `setConnectionStatus`, `setSender`, `setSnapshot`, and `appendEvents`
 * on the store.
 */
export function createConnectionController(
  options: ConnectionControllerOptions,
): ConnectionController {
  const { store, serverUrl } = options;
  const resolveToken = options.resolveToken ?? (() => "");
  const connectImpl = options.connectImpl ?? connect;
  let active: { conn: WsConnection; roomId: string } | null = null;

  const handlers: WsClientHandlers = {
    onSnapshot: (msg) => {
      store.getState().setSnapshot(msg.snapshot);
    },
    onEvents: (msg) => {
      store.getState().appendEvents(msg.events);
    },
    onError: (msg) => {
      console.error("[ws] server error", msg.code, msg.message);
    },
    onRoomState: (msg) => {
      console.debug("[ws] room state", msg.roomId, msg.you);
    },
    onStatus: (status, info) => {
      store.getState().setConnectionStatus(status, info);
    },
  };

  const openFor = (roomId: string) => {
    closeActive();
    const conn = connectImpl({ roomId, token: resolveToken(roomId), serverUrl, handlers });
    store.getState().setSender(conn.send);
    active = { conn, roomId };
  };

  const closeActive = () => {
    if (!active) return;
    active.conn.close();
    active = null;
    store.getState().setSender(null);
  };

  const reconcile = (state: AppState) => {
    if (state.phase === "lobby" || state.phase === "game") {
      const { roomCode } = state;
      if (!roomCode) {
        closeActive();
        return;
      }
      if (active && active.roomId === roomCode) return;
      openFor(roomCode);
      return;
    }
    closeActive();
  };

  return {
    start: () => {
      reconcile(store.getState());
      const unsub = store.subscribe(reconcile);
      return () => {
        unsub();
        closeActive();
      };
    },
  };
}
