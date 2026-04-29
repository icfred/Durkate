import type { Action, Event } from "@durak/engine";
import type { ClientMessage, Snapshot } from "@durak/protocol";
import { createStore } from "zustand/vanilla";

export type Phase = "menu" | "lobby" | "game" | "gameover";

export type Mode = "bot" | "friend";

export const EVENT_BUFFER_SIZE = 32;

export type ConnectionStatus = "idle" | "connecting" | "open" | "closed" | "error";

export interface ConnectionState {
  status: ConnectionStatus;
  attempts: number;
  error?: string;
}

export type ClientSender = (msg: ClientMessage) => void;

export interface GameOverData {
  youSeat: number;
  durak: number | null;
  seatNames?: (string | null)[];
}

export interface AppState {
  phase: Phase;
  mode: Mode | undefined;
  roomCode: string | undefined;
  snapshot: Snapshot | null;
  events: Event[];
  connection: ConnectionState;
  gameover: GameOverData | undefined;
  submitAction: (action: Action) => void;
  requestRematch: () => void;
  showMenu(): void;
  showLobby(args: { mode: Mode; roomCode: string }): void;
  showGame(args?: { mode?: Mode; roomCode?: string }): void;
  showGameOver(data: GameOverData): void;
  setSnapshot(snapshot: Snapshot | null): void;
  appendEvents(events: Event[]): void;
  setConnectionStatus(status: ConnectionStatus, info: { attempts: number; error?: string }): void;
  setSender(sender: ClientSender | null): void;
}

const INITIAL_CONNECTION: ConnectionState = { status: "idle", attempts: 0 };

interface InternalState extends AppState {
  __sender: ClientSender | null;
}

export const appStore = createStore<AppState>((set, get) => {
  const internal: InternalState = {
    phase: "menu",
    mode: undefined,
    roomCode: undefined,
    snapshot: null,
    events: [],
    connection: INITIAL_CONNECTION,
    gameover: undefined,
    __sender: null,
    showMenu: () =>
      set({
        phase: "menu",
        mode: undefined,
        roomCode: undefined,
        snapshot: null,
        events: [],
        gameover: undefined,
      }),
    showLobby: ({ mode, roomCode }) => set({ phase: "lobby", mode, roomCode, gameover: undefined }),
    showGame: (args) =>
      set((state) => ({
        phase: "game",
        mode: args?.mode ?? state.mode,
        roomCode: args?.roomCode ?? state.roomCode,
      })),
    showGameOver: (data) => set({ phase: "gameover", gameover: data }),
    setSnapshot: (snapshot) => set({ snapshot }),
    appendEvents: (events) =>
      set((state) => {
        if (events.length === 0) return state;
        const next = state.events.concat(events);
        const overflow = next.length - EVENT_BUFFER_SIZE;
        return { events: overflow > 0 ? next.slice(overflow) : next };
      }),
    setConnectionStatus: (status, info) => {
      const next: ConnectionState =
        info.error === undefined
          ? { status, attempts: info.attempts }
          : { status, attempts: info.attempts, error: info.error };
      set({ connection: next });
    },
    setSender: (sender) => {
      (get() as InternalState).__sender = sender;
    },
    submitAction: (action) => {
      const state = get() as InternalState;
      if (state.connection.status !== "open" || !state.__sender) {
        console.warn("[store] dropped submitAction; not connected", action);
        return;
      }
      state.__sender({ type: "SubmitAction", action });
    },
    requestRematch: () => {
      const state = get() as InternalState;
      if (state.connection.status !== "open" || !state.__sender) {
        console.warn("[store] dropped requestRematch; not connected");
        return;
      }
      state.__sender({ type: "RequestRematch" });
    },
  };
  return internal;
});

const ROOM_CODE_PATTERN = /#room=([A-Za-z0-9]+)/;

export function parseHashRoom(hash: string): string | null {
  const match = ROOM_CODE_PATTERN.exec(hash);
  const code = match?.[1];
  return code ? code.toUpperCase() : null;
}

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateRoomCode(rand: () => number = Math.random): string {
  let out = "";
  for (let i = 0; i < 4; i += 1) {
    out += ROOM_CODE_ALPHABET[Math.floor(rand() * ROOM_CODE_ALPHABET.length)];
  }
  return out;
}
