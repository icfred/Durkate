import { createStore } from "zustand/vanilla";

export type Phase = "menu" | "lobby" | "game" | "gameover";

export type Mode = "bot" | "friend";

export interface AppState {
  phase: Phase;
  mode: Mode | undefined;
  roomCode: string | undefined;
  showMenu(): void;
  showLobby(args: { mode: Mode; roomCode: string }): void;
}

export const appStore = createStore<AppState>((set) => ({
  phase: "menu",
  mode: undefined,
  roomCode: undefined,
  showMenu: () => set({ phase: "menu", mode: undefined, roomCode: undefined }),
  showLobby: ({ mode, roomCode }) => set({ phase: "lobby", mode, roomCode }),
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
