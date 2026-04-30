import type { Action, Event } from "@durak/engine";
import type {
  BotDifficulty,
  ClientMessage,
  DisconnectState,
  RoomSeat,
  SeatIndex,
  Snapshot,
} from "@durak/protocol";
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

export interface AudioState {
  muted: boolean;
}

export interface DevtoolsState {
  open: boolean;
  autoplay: boolean;
  animSpeed: number;
}

export const ANIM_SPEED_MIN = 0;
export const ANIM_SPEED_MAX = 2;
export const ANIM_SPEED_DEFAULT = 1;

export interface ServerError {
  code: string;
  message: string;
  /** Monotonic counter so subscribers can react to repeats of the same error. */
  seq: number;
}

export interface RoomMembership {
  seats: RoomSeat[];
  you: SeatIndex | null;
  rematchRequested: SeatIndex[];
  disconnect: DisconnectState | null;
  /** Bot seats currently in their pre-move "thinking" delay. Empty otherwise. */
  thinkingSeats: SeatIndex[];
}

export type RoomCreationState =
  | { status: "idle" }
  | { status: "creating" }
  | { status: "ready" }
  | { status: "error"; error: string };

export interface AppState {
  phase: Phase;
  mode: Mode | undefined;
  /** Bot difficulty selected by the host for `mode: "bot"` rooms. */
  botDifficulty: BotDifficulty | undefined;
  roomCode: string | undefined;
  /** Seat-bound token used when opening the ws to this room. */
  currentToken: string | null;
  /** Token to embed in the share URL for "play vs friend" hosts. */
  shareToken: string | null;
  roomCreation: RoomCreationState;
  snapshot: Snapshot | null;
  events: Event[];
  eventsTotal: number;
  connection: ConnectionState;
  room: RoomMembership | null;
  gameover: GameOverData | undefined;
  audio: AudioState;
  devtools: DevtoolsState;
  lastError: ServerError | null;
  submitAction: (action: Action) => void;
  requestRematch: () => void;
  showMenu(): void;
  showLobby(args: { mode: Mode; roomCode: string; token?: string | null }): void;
  showGame(args?: { mode?: Mode; roomCode?: string }): void;
  showGameOver(data: GameOverData): void;
  beginRoomCreation(args: { mode: Mode; difficulty?: BotDifficulty }): void;
  roomCreated(args: { roomId: string; hostToken: string; shareToken?: string | null }): void;
  roomCreationFailed(error: string): void;
  enterLobbyAsJoiner(args: { roomCode: string; token: string }): void;
  setSnapshot(snapshot: Snapshot | null): void;
  appendEvents(events: Event[]): void;
  setConnectionStatus(status: ConnectionStatus, info: { attempts: number; error?: string }): void;
  setRoomMembership(room: RoomMembership | null): void;
  setSender(sender: ClientSender | null): void;
  toggleMute(): void;
  setMuted(muted: boolean): void;
  setDevtoolsOpen(open: boolean): void;
  toggleDevtools(): void;
  setAutoplay(autoplay: boolean): void;
  setAnimSpeed(speed: number): void;
  setError(code: string, message: string): void;
  clearError(): void;
}

const INITIAL_CONNECTION: ConnectionState = { status: "idle", attempts: 0 };
const INITIAL_ROOM_CREATION: RoomCreationState = { status: "idle" };

const MUTED_STORAGE_KEY = "durak.audio.muted";
const DEVTOOLS_STORAGE_KEY = "durak.devtools";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function getStorage(): StorageLike | undefined {
  if (typeof globalThis === "undefined") return undefined;
  const candidate = (globalThis as { localStorage?: StorageLike }).localStorage;
  return candidate;
}

function readMuted(): boolean {
  const storage = getStorage();
  if (!storage) return false;
  try {
    return storage.getItem(MUTED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeMuted(muted: boolean): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(MUTED_STORAGE_KEY, muted ? "1" : "0");
  } catch {
    // localStorage can throw in private mode or quota-exceeded; swallow.
  }
}

export function clampAnimSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return ANIM_SPEED_DEFAULT;
  if (speed < ANIM_SPEED_MIN) return ANIM_SPEED_MIN;
  if (speed > ANIM_SPEED_MAX) return ANIM_SPEED_MAX;
  return speed;
}

function readDevtools(): DevtoolsState {
  const fallback: DevtoolsState = {
    open: false,
    autoplay: false,
    animSpeed: ANIM_SPEED_DEFAULT,
  };
  const storage = getStorage();
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(DEVTOOLS_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<DevtoolsState>;
    return {
      open: typeof parsed.open === "boolean" ? parsed.open : fallback.open,
      autoplay: typeof parsed.autoplay === "boolean" ? parsed.autoplay : fallback.autoplay,
      animSpeed:
        typeof parsed.animSpeed === "number"
          ? clampAnimSpeed(parsed.animSpeed)
          : fallback.animSpeed,
    };
  } catch {
    return fallback;
  }
}

function writeDevtools(state: DevtoolsState): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(DEVTOOLS_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage can throw in private mode or quota-exceeded; swallow.
  }
}

interface InternalState extends AppState {
  __sender: ClientSender | null;
}

export const appStore = createStore<AppState>((set, get) => {
  const internal: InternalState = {
    phase: "menu",
    mode: undefined,
    botDifficulty: undefined,
    roomCode: undefined,
    currentToken: null,
    shareToken: null,
    roomCreation: INITIAL_ROOM_CREATION,
    snapshot: null,
    events: [],
    eventsTotal: 0,
    connection: INITIAL_CONNECTION,
    room: null,
    gameover: undefined,
    audio: { muted: readMuted() },
    devtools: readDevtools(),
    lastError: null,
    __sender: null,
    showMenu: () =>
      set({
        phase: "menu",
        mode: undefined,
        botDifficulty: undefined,
        roomCode: undefined,
        currentToken: null,
        shareToken: null,
        roomCreation: INITIAL_ROOM_CREATION,
        snapshot: null,
        events: [],
        eventsTotal: 0,
        room: null,
        gameover: undefined,
      }),
    showLobby: ({ mode, roomCode, token }) =>
      set({
        phase: "lobby",
        mode,
        roomCode,
        currentToken: token ?? null,
        gameover: undefined,
      }),
    showGame: (args) =>
      set((state) => ({
        phase: "game",
        mode: args?.mode ?? state.mode,
        roomCode: args?.roomCode ?? state.roomCode,
      })),
    showGameOver: (data) => set({ phase: "gameover", gameover: data }),
    beginRoomCreation: ({ mode, difficulty }) =>
      set({
        phase: "lobby",
        mode,
        botDifficulty: mode === "bot" ? difficulty : undefined,
        roomCode: undefined,
        currentToken: null,
        shareToken: null,
        roomCreation: { status: "creating" },
        gameover: undefined,
        room: null,
      }),
    roomCreated: ({ roomId, hostToken, shareToken }) =>
      set({
        roomCode: roomId,
        currentToken: hostToken,
        shareToken: shareToken ?? null,
        roomCreation: { status: "ready" },
      }),
    roomCreationFailed: (error) => set({ roomCreation: { status: "error", error } }),
    enterLobbyAsJoiner: ({ roomCode, token }) =>
      set({
        phase: "lobby",
        mode: "friend",
        botDifficulty: undefined,
        roomCode,
        currentToken: token,
        shareToken: null,
        roomCreation: { status: "ready" },
        gameover: undefined,
      }),
    setSnapshot: (snapshot) => set({ snapshot }),
    setRoomMembership: (room) => set({ room }),
    appendEvents: (events) =>
      set((state) => {
        if (events.length === 0) return state;
        const next = state.events.concat(events);
        const overflow = next.length - EVENT_BUFFER_SIZE;
        return {
          events: overflow > 0 ? next.slice(overflow) : next,
          eventsTotal: state.eventsTotal + events.length,
        };
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
    toggleMute: () => {
      const next = !get().audio.muted;
      writeMuted(next);
      set({ audio: { muted: next } });
    },
    setMuted: (muted: boolean) => {
      writeMuted(muted);
      set({ audio: { muted } });
    },
    setDevtoolsOpen: (open: boolean) => {
      const next = { ...get().devtools, open };
      writeDevtools(next);
      set({ devtools: next });
    },
    toggleDevtools: () => {
      const next = { ...get().devtools, open: !get().devtools.open };
      writeDevtools(next);
      set({ devtools: next });
    },
    setAutoplay: (autoplay: boolean) => {
      const next = { ...get().devtools, autoplay };
      writeDevtools(next);
      set({ devtools: next });
    },
    setAnimSpeed: (speed: number) => {
      const next = { ...get().devtools, animSpeed: clampAnimSpeed(speed) };
      writeDevtools(next);
      set({ devtools: next });
    },
    setError: (code, message) =>
      set((state) => ({
        lastError: { code, message, seq: (state.lastError?.seq ?? 0) + 1 },
      })),
    clearError: () => set({ lastError: null }),
  };
  return internal;
});

const HASH_ROOM = /(?:^|[#&])room=([A-Za-z0-9_-]+)/;
const HASH_TOKEN = /(?:^|[#&])t=([A-Za-z0-9_-]+)/;

export function parseHashRoom(hash: string): string | null {
  const match = HASH_ROOM.exec(hash);
  return match?.[1] ?? null;
}

export function parseHashJoin(hash: string): { roomCode: string; token: string } | null {
  const room = parseHashRoom(hash);
  const tokenMatch = HASH_TOKEN.exec(hash);
  if (room === null || !tokenMatch?.[1]) return null;
  return { roomCode: room, token: tokenMatch[1] };
}

export function buildShareUrl(origin: string, roomCode: string, joinToken: string): string {
  return `${origin}/#room=${encodeURIComponent(roomCode)}&t=${encodeURIComponent(joinToken)}`;
}
