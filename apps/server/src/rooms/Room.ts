import { randomBytes } from "node:crypto";
import {
  type Action,
  bot,
  type Event,
  type InRoundState,
  initialState,
  type RejectReason,
  type State,
  step,
} from "@durak/engine";
import type { ServerMessage, Snapshot } from "@durak/protocol";
import { redactFor } from "../redact.js";

export type SeatIndex = 0 | 1;
export type RoomMode = "human" | "bot";

export interface Seat {
  readonly index: SeatIndex;
  readonly name: string;
  readonly token: string;
}

export interface JoinResult {
  readonly seat: SeatIndex;
  readonly token: string;
}

export interface ClientHandle {
  send(payload: string): void;
  close(): void;
}

export class RoomFullError extends Error {
  constructor() {
    super("Room is full");
    this.name = "RoomFullError";
  }
}

export type ApplyResult =
  | { ok: true; state: State; events: Event[] }
  | { ok: false; reason: RejectReason | "GAME_NOT_STARTED" | "FORBIDDEN_ACTION" };

export type SetTimeoutFn = (cb: () => void, ms: number) => unknown;
export type ClearTimeoutFn = (handle: unknown) => void;

export interface RoomOpts {
  id?: string;
  mode?: RoomMode;
  turnTimeoutMs?: number;
  setTimeoutFn?: SetTimeoutFn;
  clearTimeoutFn?: ClearTimeoutFn;
  botIterationCap?: number;
}

const SEAT_COUNT = 2;
const TOKEN_BYTES = 32;
const ROOM_ID_BYTES = 12;
const DEFAULT_TURN_TIMEOUT_MS = 30_000;
const BOT_SEAT_INDEX: SeatIndex = 1;
// Caps a defensive runaway loop in the bot driver. The bot is deterministic
// and a 36-card 1v1 game never approaches this many bot decisions; tripping
// the cap means the bot picked an illegal move or the active actor never
// transferred away from the bot. Either way, end the round with an Error.
const DEFAULT_BOT_ITERATION_CAP = 200;

function randomBase64Url(byteLength: number): string {
  return randomBytes(byteLength).toString("base64url");
}

export class Room {
  readonly id: string;
  readonly mode: RoomMode;
  private readonly seats: (Seat | null)[] = new Array<Seat | null>(SEAT_COUNT).fill(null);
  private readonly clients = new Map<SeatIndex, ClientHandle>();
  private readonly turnTimeoutMs: number;
  private readonly setTimeoutFn: SetTimeoutFn;
  private readonly clearTimeoutFn: ClearTimeoutFn;
  private readonly botSeat: SeatIndex | null;
  private readonly botIterationCap: number;
  private state: State | null = null;
  private turnTimer: unknown = null;

  constructor(opts: RoomOpts = {}) {
    this.id = opts.id ?? randomBase64Url(ROOM_ID_BYTES);
    this.mode = opts.mode ?? "human";
    this.turnTimeoutMs = opts.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.setTimeoutFn = opts.setTimeoutFn ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
    this.clearTimeoutFn =
      opts.clearTimeoutFn ??
      ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.botIterationCap = opts.botIterationCap ?? DEFAULT_BOT_ITERATION_CAP;
    if (this.mode === "bot") {
      this.botSeat = BOT_SEAT_INDEX;
      this.seats[BOT_SEAT_INDEX] = {
        index: BOT_SEAT_INDEX,
        name: "Bot",
        // Token is generated for shape parity with human seats. The bot
        // never opens a ws, so this token is never consumed.
        token: randomBase64Url(TOKEN_BYTES),
      };
    } else {
      this.botSeat = null;
    }
  }

  addPlayer(name: string): JoinResult {
    const seat = this.seats.indexOf(null);
    if (seat === -1) throw new RoomFullError();
    const token = randomBase64Url(TOKEN_BYTES);
    const seatIndex = seat as SeatIndex;
    this.seats[seatIndex] = { index: seatIndex, name, token };
    return { seat: seatIndex, token };
  }

  removePlayer(token: string): boolean {
    const seat = this.seatForToken(token);
    if (seat === undefined) return false;
    if (seat === this.botSeat) return false;
    this.seats[seat] = null;
    this.clients.delete(seat);
    return true;
  }

  seatForToken(token: string): SeatIndex | undefined {
    for (let i = 0; i < this.seats.length; i++) {
      const s = this.seats[i];
      if (s !== null && s !== undefined && s.token === token) return i as SeatIndex;
    }
    return undefined;
  }

  attachClient(seat: SeatIndex, client: ClientHandle): void {
    this.clients.set(seat, client);
  }

  detachClient(seat: SeatIndex): void {
    this.clients.delete(seat);
  }

  clientForSeat(seat: SeatIndex): ClientHandle | undefined {
    return this.clients.get(seat);
  }

  publicSeats(): { name: string | null }[] {
    return this.seats.map((s) => ({ name: s ? s.name : null }));
  }

  hasState(): boolean {
    return this.state !== null;
  }

  bothSeatsFilled(): boolean {
    return this.seats.every((s) => s !== null);
  }

  attachedSeatCount(): number {
    return this.clients.size + (this.botSeat !== null ? 1 : 0);
  }

  currentState(): State | null {
    return this.state;
  }

  snapshotFor(seat: SeatIndex): Snapshot | null {
    if (this.state === null || this.state.phase !== "in-round") return null;
    return redactFor(this.state, seat);
  }

  start(seed: number): Event[] {
    if (this.state !== null) throw new Error("Room already started");
    if (!this.bothSeatsFilled()) throw new Error("Both seats must be filled before start");
    const initial = initialState({ seed });
    const result = step(initial, { type: "START_GAME" });
    if (!result.ok) throw new Error(`START_GAME failed: ${result.reason}`);
    this.state = result.state;
    this.broadcastSnapshotsAndEvents(result.events);
    const events: Event[] = [...result.events];
    events.push(...this.runBotTurns());
    this.scheduleTurnTimer();
    return events;
  }

  applyAction(seat: SeatIndex, action: Action): ApplyResult {
    if (this.state === null) {
      return { ok: false, reason: "GAME_NOT_STARTED" };
    }
    if (action.type === "START_GAME") {
      return { ok: false, reason: "FORBIDDEN_ACTION" };
    }
    if (seat === this.botSeat) {
      return { ok: false, reason: "FORBIDDEN_ACTION" };
    }
    const enforced = { ...action, by: seat };
    const result = step(this.state, enforced);
    if (!result.ok) return { ok: false, reason: result.reason };
    this.state = result.state;
    this.cancelTurnTimer();
    this.broadcastSnapshotsAndEvents(result.events);
    const events: Event[] = [...result.events];
    events.push(...this.runBotTurns());
    this.scheduleTurnTimer();
    return { ok: true, state: this.state, events };
  }

  forceTurnTimeout(): void {
    this.cancelTurnTimer();
    this.onTurnTimeout();
  }

  shutdown(): void {
    this.cancelTurnTimer();
  }

  private broadcastSnapshotsAndEvents(events: Event[]): void {
    if (this.state === null) return;
    const inRound = this.state.phase === "in-round";
    for (const seat of this.clients.keys()) {
      if (inRound) {
        const snapshot = redactFor(this.state, seat);
        this.sendTo(seat, { type: "Snapshot", snapshot });
      }
      // Always emit events, even after game-over — the GAME_OVER event is
      // what drives the client off the game screen. Skipping the events
      // here is what stranded the client in the `game` phase forever.
      if (events.length > 0) this.sendTo(seat, { type: "Events", events });
    }
  }

  private sendTo(seat: SeatIndex, msg: ServerMessage): void {
    this.clients.get(seat)?.send(JSON.stringify(msg));
  }

  private scheduleTurnTimer(): void {
    if (this.state === null || this.state.phase !== "in-round") return;
    this.turnTimer = this.setTimeoutFn(() => this.onTurnTimeout(), this.turnTimeoutMs);
  }

  private cancelTurnTimer(): void {
    if (this.turnTimer !== null) {
      this.clearTimeoutFn(this.turnTimer);
      this.turnTimer = null;
    }
  }

  private onTurnTimeout(): void {
    this.turnTimer = null;
    if (this.state === null || this.state.phase !== "in-round") return;
    const action = synthesizeTimeoutAction(this.state);
    if (action === null) {
      this.scheduleTurnTimer();
      return;
    }
    const result = step(this.state, action);
    if (!result.ok) {
      this.scheduleTurnTimer();
      return;
    }
    this.state = result.state;
    this.broadcastSnapshotsAndEvents(result.events);
    this.runBotTurns();
    this.scheduleTurnTimer();
  }

  private runBotTurns(): Event[] {
    const collected: Event[] = [];
    if (this.botSeat === null) return collected;
    for (let i = 0; i < this.botIterationCap; i++) {
      if (this.state === null || this.state.phase !== "in-round") return collected;
      const active = activeActorSeat(this.state);
      if (active !== this.botSeat) return collected;
      const action = bot.choose(this.state);
      const result = step(this.state, action);
      if (!result.ok) {
        this.sendErrorToHuman("BOT_ILLEGAL_ACTION", `bot rejected: ${result.reason}`);
        return collected;
      }
      this.state = result.state;
      this.broadcastSnapshotsAndEvents(result.events);
      collected.push(...result.events);
    }
    this.sendErrorToHuman("BOT_LOOP_CAP", "bot iteration cap reached");
    return collected;
  }

  private sendErrorToHuman(code: string, message: string): void {
    if (this.botSeat === null) return;
    const humanSeat = (this.botSeat === 0 ? 1 : 0) as SeatIndex;
    this.sendTo(humanSeat, { type: "Error", code, message });
  }
}

export function activeActorSeat(state: InRoundState): number {
  if (state.table.length === 0) return state.attacker;
  const undefended = state.table.some((p) => p.defense === undefined);
  return undefended ? state.defender : state.attacker;
}

export function synthesizeTimeoutAction(state: State): Action | null {
  if (state.phase !== "in-round") return null;
  if (state.table.length === 0) return null;
  const hasUndefended = state.table.some((p) => p.defense === undefined);
  if (hasUndefended) {
    return { type: "TAKE_PILE", by: state.defender };
  }
  return { type: "END_ROUND", by: state.attacker };
}
