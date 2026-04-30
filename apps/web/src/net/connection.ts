import type { StoreApi } from "zustand/vanilla";
import type { AppState } from "../store.js";
import { connect, type WsClientHandlers, type WsConnection } from "./wsClient.js";

export interface ConnectionControllerOptions {
  store: StoreApi<AppState>;
  serverUrl: string;
  /** Resolves the per-connection auth token. Defaults to `store.currentToken`. */
  resolveToken?: (roomId: string) => string;
  /** Test seam: replaces the underlying `connect` impl. */
  connectImpl?: typeof connect;
}

export interface ConnectionController {
  start(): () => void;
  /**
   * Force-close the active websocket (dev tool). The reconnect loop will
   * not fire because the controller's reconcile path is what would re-open
   * a connection, and `closeActive` clears `active` so the next reconcile
   * sees no socket and opens a fresh one only when the store says so.
   */
  forceDisconnect(): void;
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
  const resolveToken = options.resolveToken ?? (() => store.getState().currentToken ?? "");
  const connectImpl = options.connectImpl ?? connect;
  let active: { conn: WsConnection | null; roomId: string } | null = null;

  const handlers: WsClientHandlers = {
    onSnapshot: (msg) => {
      const state = store.getState();
      state.setSnapshot(msg.snapshot);
      // lobby→game on first snapshot of a new game; gameover→game on a
      // rematch snapshot from the same connection.
      if (state.phase === "lobby" || state.phase === "gameover") state.showGame();
    },
    onEvents: (msg) => {
      const state = store.getState();
      state.appendEvents(msg.events);
      const over = msg.events.find((e) => e.type === "GAME_OVER");
      if (over && state.phase !== "gameover") {
        const youSeat = state.snapshot?.you.seat ?? state.room?.you ?? 0;
        const seatNames = state.room?.seats.map((s) => s.name);
        state.showGameOver({
          youSeat,
          durak: over.durak,
          ...(seatNames ? { seatNames } : {}),
        });
      }
    },
    onError: (msg) => {
      console.error("[ws] server error", msg.code, msg.message);
      store.getState().setError(msg.code, msg.message);
    },
    onRoomState: (msg) => {
      store.getState().setRoomMembership({
        seats: msg.seats,
        you: msg.you,
        rematchRequested: msg.rematchRequested,
        disconnect: msg.disconnect ?? null,
      });
    },
    onStatus: (status, info) => {
      const state = store.getState();
      state.setConnectionStatus(status, info);
      if (status === "closed" && state.phase === "game" && state.roomCode && state.mode) {
        state.showLobby({
          mode: state.mode,
          roomCode: state.roomCode,
          token: state.currentToken,
        });
      }
    },
  };

  const openFor = (roomId: string) => {
    closeActive();
    // Reserve `active` before connecting. `connectImpl` synchronously fires
    // setStatus("connecting"), which triggers a store-subscriber re-entry
    // into `reconcile`. If `active` is still null at that point, reconcile
    // calls `openFor` again — infinite recursion.
    active = { conn: null, roomId };
    const conn = connectImpl({ roomId, token: resolveToken(roomId), serverUrl, handlers });
    active.conn = conn;
    store.getState().setSender(conn.send);
  };

  const closeActive = () => {
    if (!active) return;
    active.conn?.close();
    active = null;
    store.getState().setSender(null);
  };

  const reconcile = (state: AppState) => {
    if (state.phase === "lobby" || state.phase === "game" || state.phase === "gameover") {
      const { roomCode, currentToken } = state;
      if (!roomCode || !currentToken) {
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
    forceDisconnect: () => {
      closeActive();
    },
  };
}
