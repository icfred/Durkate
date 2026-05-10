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
      const state = store.getState();
      // GAME_NOT_STARTED on the game screen means the room was evicted
      // out from under us but the close-code path didn't fire (e.g. the
      // WS reconnected against an empty DO). Same recovery as the
      // explicit room-expired close: bounce to menu with a toast.
      if (msg.code === "GAME_NOT_STARTED" && state.phase === "game") {
        state.setError("ROOM_EXPIRED", "This room has expired. Start a new game.");
        state.showMenu();
        return;
      }
      state.setError(msg.code, msg.message);
    },
    onRoomState: (msg) => {
      const disconnects = msg.disconnects ?? (msg.disconnect ? [msg.disconnect] : []);
      store.getState().setRoomMembership({
        seats: msg.seats,
        you: msg.you,
        rematchRequested: msg.rematchRequested,
        disconnect: disconnects[0] ?? null,
        disconnects,
        thinkingSeats: msg.thinkingSeats ?? [],
        eliminated: msg.eliminated ?? [],
        pendingClose: msg.pendingClose ?? null,
        turnDeadline: msg.turnDeadline ?? null,
        match: msg.match ?? null,
      });
    },
    onStatus: (status, info) => {
      const state = store.getState();
      state.setConnectionStatus(status, info);
      // Room-expired (server evict): the room is gone, not coming back.
      // Bounce all the way to the menu and surface a banner — the lobby
      // would just try to reconnect to the same dead room.
      if (status === "error" && info.error === "room expired") {
        state.setError("ROOM_EXPIRED", "This room has expired. Start a new game.");
        state.showMenu();
        return;
      }
      // Only bounce to the lobby on a terminal `error` status. The
      // wsClient auto-retries through `closed` events with backoff —
      // bouncing on every transient `closed` would surface a one-frame
      // lobby flash any time the worker hibernated and dropped the
      // socket, even though the very next reconnect succeeds and
      // `sendCurrentState` replays the in-progress engine state. After
      // a permanent failure (max reconnect attempts) the user gets the
      // explicit "lost the room" landing instead of a stale game view.
      if (status === "error" && state.phase === "game" && state.roomCode && state.mode) {
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
