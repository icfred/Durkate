import { randomBytes } from "node:crypto";
import {
  type Action,
  type Event,
  initialState,
  type RejectReason,
  type State,
  step,
} from "@durak/engine";
import type { ServerMessage, Snapshot } from "@durak/protocol";
import { redactFor } from "../redact.js";

export type SeatIndex = 0 | 1;

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
  turnTimeoutMs?: number;
  setTimeoutFn?: SetTimeoutFn;
  clearTimeoutFn?: ClearTimeoutFn;
}

const SEAT_COUNT = 2;
const TOKEN_BYTES = 32;
const ROOM_ID_BYTES = 12;
const DEFAULT_TURN_TIMEOUT_MS = 30_000;

function randomBase64Url(byteLength: number): string {
  return randomBytes(byteLength).toString("base64url");
}

export class Room {
  readonly id: string;
  private readonly seats: (Seat | null)[] = new Array<Seat | null>(SEAT_COUNT).fill(null);
  private readonly clients = new Map<SeatIndex, ClientHandle>();
  private readonly turnTimeoutMs: number;
  private readonly setTimeoutFn: SetTimeoutFn;
  private readonly clearTimeoutFn: ClearTimeoutFn;
  private state: State | null = null;
  private turnTimer: unknown = null;

  constructor(opts: RoomOpts = {}) {
    this.id = opts.id ?? randomBase64Url(ROOM_ID_BYTES);
    this.turnTimeoutMs = opts.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.setTimeoutFn = opts.setTimeoutFn ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
    this.clearTimeoutFn =
      opts.clearTimeoutFn ??
      ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
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
    return this.clients.size;
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
    this.scheduleTurnTimer();
    return result.events;
  }

  applyAction(seat: SeatIndex, action: Action): ApplyResult {
    if (this.state === null) {
      return { ok: false, reason: "GAME_NOT_STARTED" };
    }
    if (action.type === "START_GAME") {
      return { ok: false, reason: "FORBIDDEN_ACTION" };
    }
    const enforced = { ...action, by: seat };
    const result = step(this.state, enforced);
    if (!result.ok) return { ok: false, reason: result.reason };
    this.state = result.state;
    this.cancelTurnTimer();
    this.broadcastSnapshotsAndEvents(result.events);
    this.scheduleTurnTimer();
    return { ok: true, state: this.state, events: result.events };
  }

  forceTurnTimeout(): void {
    this.cancelTurnTimer();
    this.onTurnTimeout();
  }

  shutdown(): void {
    this.cancelTurnTimer();
  }

  private broadcastSnapshotsAndEvents(events: Event[]): void {
    if (this.state === null || this.state.phase !== "in-round") return;
    for (const seat of this.clients.keys()) {
      const snapshot = redactFor(this.state, seat);
      this.sendTo(seat, { type: "Snapshot", snapshot });
      this.sendTo(seat, { type: "Events", events });
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
    this.scheduleTurnTimer();
  }
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
