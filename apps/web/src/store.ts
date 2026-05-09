import type { Action, Event } from "@durak/engine";
import type {
  BotDifficulty,
  ClientMessage,
  DisconnectState,
  MatchState,
  PendingCloseState,
  RoomSeat,
  SeatIndex,
  Snapshot,
} from "@durak/protocol";
import { createStore } from "zustand/vanilla";

export type Phase = "menu" | "lobby" | "game" | "gameover";

export type Mode = "bot" | "friend" | "ffa";

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
  /** Earliest pending disconnect, or null. Mirrors `disconnects[0]`. */
  disconnect: DisconnectState | null;
  /** All currently disconnected seats (multi-disconnect for N>2). */
  disconnects: DisconnectState[];
  /** Bot seats currently in their pre-move "thinking" delay. Empty otherwise. */
  thinkingSeats: SeatIndex[];
  /** Seats eliminated this game (hand emptied + talon exhausted, or forfeited). */
  eliminated: SeatIndex[];
  /** Pending throw-in close window (ADR-0011), null when not in a window. */
  pendingClose: PendingCloseState | null;
  /**
   * Wall-clock ms at which the active actor's turn times out. Null when
   * no timer is armed. Suppressed by the server during a `pendingClose`
   * window — that banner owns the visible countdown in that state.
   */
  turnDeadline: number | null;
  /**
   * Best-of-N match state. Null on legacy single-round rooms — clients
   * fall back to the existing rematch flow. Populated when the server
   * is running a multi-round match (totalRounds > 1). Optional in the
   * interface so existing test fixtures don't need updating.
   */
  match?: MatchState | null;
}

export type RoomCreationState =
  | { status: "idle" }
  | { status: "creating" }
  | { status: "ready" }
  | { status: "error"; error: string };

export interface RoomCreationConfig {
  mode: Mode;
  difficulty?: BotDifficulty | undefined;
  playerCount?: number;
  botCount?: number;
}

export interface RoomCreatedPayload {
  roomId: string;
  hostToken: string;
  /** Tokens for each remaining human seat. Empty for solo-vs-bots. */
  joinTokens?: string[];
  /** Legacy single-token field (kept until the last call site stops using it). */
  shareToken?: string | null;
}

export interface JoinerEntryPayload {
  roomCode: string;
  token: string;
  playerCount?: number;
  botCount?: number;
}

export interface AppState {
  phase: Phase;
  mode: Mode | undefined;
  /** Bot difficulty selected by the host for `mode: "bot"` / `mode: "ffa"` rooms. */
  botDifficulty: BotDifficulty | undefined;
  /** Total seats in the room (humans + bots). */
  playerCount: number | undefined;
  /** Bot seats in the room. */
  botCount: number | undefined;
  roomCode: string | undefined;
  /** Seat-bound token used when opening the ws to this room. */
  currentToken: string | null;
  /** Tokens the host can hand out for remaining human seats. */
  joinTokens: string[];
  /**
   * Legacy single-share alias - still surfaced so older lobby paths work.
   * Equals `joinTokens[0] ?? null`.
   */
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
  startGame: () => void;
  showMenu(): void;
  showLobby(args: { mode: Mode; roomCode: string; token?: string | null }): void;
  showGame(args?: { mode?: Mode; roomCode?: string }): void;
  showGameOver(data: GameOverData): void;
  beginRoomCreation(config: RoomCreationConfig): void;
  roomCreated(args: RoomCreatedPayload): void;
  roomCreationFailed(error: string): void;
  enterLobbyAsJoiner(args: JoinerEntryPayload): void;
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
    playerCount: undefined,
    botCount: undefined,
    roomCode: undefined,
    currentToken: null,
    joinTokens: [],
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
        playerCount: undefined,
        botCount: undefined,
        roomCode: undefined,
        currentToken: null,
        joinTokens: [],
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
    beginRoomCreation: ({ mode, difficulty, playerCount, botCount }) =>
      set({
        phase: "lobby",
        mode,
        botDifficulty: mode === "bot" || mode === "ffa" ? difficulty : undefined,
        playerCount,
        botCount,
        roomCode: undefined,
        currentToken: null,
        joinTokens: [],
        shareToken: null,
        roomCreation: { status: "creating" },
        gameover: undefined,
        room: null,
      }),
    roomCreated: ({ roomId, hostToken, joinTokens, shareToken }) => {
      const tokens = joinTokens ?? (shareToken ? [shareToken] : []);
      set({
        roomCode: roomId,
        currentToken: hostToken,
        joinTokens: tokens,
        shareToken: tokens[0] ?? null,
        roomCreation: { status: "ready" },
      });
    },
    roomCreationFailed: (error) => set({ roomCreation: { status: "error", error } }),
    enterLobbyAsJoiner: ({ roomCode, token, playerCount, botCount }) =>
      set({
        phase: "lobby",
        mode: "friend",
        botDifficulty: undefined,
        playerCount,
        botCount,
        roomCode,
        currentToken: token,
        joinTokens: [],
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
    startGame: () => {
      const state = get() as InternalState;
      if (state.connection.status !== "open" || !state.__sender) {
        console.warn("[store] dropped startGame; not connected");
        return;
      }
      state.__sender({ type: "StartGame" });
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
const HASH_TOKEN = /(?:^|[#&])t=([A-Za-z0-9_,-]+)/;
const HASH_PC = /(?:^|[#&])pc=(\d+)/;
const HASH_BC = /(?:^|[#&])bc=(\d+)/;

export function parseHashRoom(hash: string): string | null {
  const match = HASH_ROOM.exec(hash);
  return match?.[1] ?? null;
}

export interface HashJoinPayload {
  roomCode: string;
  /** First token, retained for back-compat with single-token share URLs. */
  token: string;
  /** Full token list - one per remaining human seat for multi-share URLs. */
  tokens: string[];
  playerCount?: number;
  botCount?: number;
}

export function parseHashJoin(hash: string): HashJoinPayload | null {
  const room = parseHashRoom(hash);
  const tokenMatch = HASH_TOKEN.exec(hash);
  if (room === null || !tokenMatch?.[1]) return null;
  const tokens = tokenMatch[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (tokens.length === 0) return null;
  const pcMatch = HASH_PC.exec(hash);
  const bcMatch = HASH_BC.exec(hash);
  const out: HashJoinPayload = {
    roomCode: room,
    token: tokens[0] as string,
    tokens,
  };
  if (pcMatch?.[1]) out.playerCount = Number.parseInt(pcMatch[1], 10);
  if (bcMatch?.[1]) out.botCount = Number.parseInt(bcMatch[1], 10);
  return out;
}

export interface ShareUrlOptions {
  playerCount?: number;
  botCount?: number;
}

export function buildShareUrl(
  origin: string,
  roomCode: string,
  joinToken: string,
  options?: ShareUrlOptions,
): string {
  const params = [`room=${encodeURIComponent(roomCode)}`, `t=${encodeURIComponent(joinToken)}`];
  if (options?.playerCount !== undefined) params.push(`pc=${options.playerCount}`);
  if (options?.botCount !== undefined) params.push(`bc=${options.botCount}`);
  return `${origin}/#${params.join("&")}`;
}
