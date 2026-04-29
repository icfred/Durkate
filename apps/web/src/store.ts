import type { Action, Event } from "@durak/engine";
import type { Snapshot } from "@durak/protocol";
import { createStore } from "zustand/vanilla";

export type Phase = "menu" | "lobby" | "game" | "gameover";

export type Mode = "bot" | "friend";

export const EVENT_BUFFER_SIZE = 32;

export interface AppState {
  phase: Phase;
  mode: Mode | undefined;
  roomCode: string | undefined;
  snapshot: Snapshot | null;
  events: Event[];
  submitAction: (action: Action) => void;
  showMenu(): void;
  showLobby(args: { mode: Mode; roomCode: string }): void;
  showGame(args?: { mode?: Mode; roomCode?: string }): void;
  setSnapshot(snapshot: Snapshot | null): void;
  appendEvents(events: Event[]): void;
  setSubmitAction(submit: (action: Action) => void): void;
}

const defaultSubmitAction = (action: Action): void => {
  console.warn("[web] submitAction no-op (no connection wired)", action);
};

export const appStore = createStore<AppState>((set) => ({
  phase: "menu",
  mode: undefined,
  roomCode: undefined,
  snapshot: null,
  events: [],
  submitAction: defaultSubmitAction,
  showMenu: () =>
    set({ phase: "menu", mode: undefined, roomCode: undefined, snapshot: null, events: [] }),
  showLobby: ({ mode, roomCode }) => set({ phase: "lobby", mode, roomCode }),
  showGame: (args) =>
    set((state) => ({
      phase: "game",
      mode: args?.mode ?? state.mode,
      roomCode: args?.roomCode ?? state.roomCode,
    })),
  setSnapshot: (snapshot) => set({ snapshot }),
  appendEvents: (events) =>
    set((state) => {
      if (events.length === 0) return state;
      const next = state.events.concat(events);
      const overflow = next.length - EVENT_BUFFER_SIZE;
      return { events: overflow > 0 ? next.slice(overflow) : next };
    }),
  setSubmitAction: (submit) => set({ submitAction: submit }),
}));

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
