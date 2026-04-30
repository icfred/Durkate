import { DurableObject } from "cloudflare:workers";
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
import {
  type ClientMessage,
  type CreateRoomResponse,
  type ErrorMessage,
  parseClientMessage,
  type RoomSeat,
  type RoomStateMessage,
  type ServerMessage,
} from "@durak/protocol";
import { ZodError } from "zod";
import { TokenBucket } from "./rate-limit.js";
import { redactFor } from "./redact.js";

export type SeatIndex = 0 | 1;
export type RoomMode = "human" | "bot";

interface Seat {
  readonly name: string;
  readonly token: string;
}

interface PersistedRoom {
  mode: RoomMode;
  seats: (Seat | null)[];
  engine: State | null;
  botSeat: SeatIndex | null;
  rematchSeats?: boolean[];
}

interface WsAttachment {
  seat: SeatIndex;
}

const SEAT_COUNT = 2;
const TOKEN_BYTES = 32;
const BOT_SEAT_INDEX: SeatIndex = 1;
const DEFAULT_BOT_ITERATION_CAP = 200;
const DEFAULT_RATE_LIMIT = { capacity: 20, refillIntervalMs: 5_000 };
const STORAGE_KEY = "room";

interface Env {
  TURN_TIMEOUT_MS?: string;
  RATE_LIMIT_CAPACITY?: string;
}

export class Room extends DurableObject<Env> {
  private mode: RoomMode = "human";
  private seats: (Seat | null)[] = new Array<Seat | null>(SEAT_COUNT).fill(null);
  private engineState: State | null = null;
  private botSeat: SeatIndex | null = null;
  private rematchSeats: boolean[] = new Array<boolean>(SEAT_COUNT).fill(false);
  private readonly turnTimeoutMs: number;
  private readonly botIterationCap: number;
  private readonly rateLimitCapacity: number;
  // Per-connection rate-limit buckets. WeakMap so hibernated sockets dropped
  // by miniflare clean up automatically; new buckets are lazily reconstructed
  // on first message after a wake-up (acceptable: a long quiet period refills
  // the bucket fully anyway).
  private readonly buckets = new WeakMap<WebSocket, TokenBucket>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.turnTimeoutMs = Number(env.TURN_TIMEOUT_MS ?? "30000");
    this.botIterationCap = DEFAULT_BOT_ITERATION_CAP;
    const capacityOverride = Number(env.RATE_LIMIT_CAPACITY ?? "");
    this.rateLimitCapacity =
      Number.isFinite(capacityOverride) && capacityOverride > 0
        ? capacityOverride
        : DEFAULT_RATE_LIMIT.capacity;
    void this.ctx.blockConcurrencyWhile(async () => {
      const persisted = await this.ctx.storage.get<PersistedRoom>(STORAGE_KEY);
      if (persisted) {
        this.mode = persisted.mode;
        this.seats = persisted.seats;
        this.engineState = persisted.engine;
        this.botSeat = persisted.botSeat;
        if (persisted.rematchSeats) this.rematchSeats = persisted.rematchSeats.slice();
      }
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/init") {
      return this.handleInit(request);
    }
    if (request.method === "GET" && url.pathname === "/ws") {
      return this.handleWsUpgrade(request);
    }
    return new Response("not found", { status: 404 });
  }

  private async handleInit(request: Request): Promise<Response> {
    if (this.seats.some((s) => s !== null)) {
      return new Response("room already initialized", { status: 409 });
    }
    const body = (await request.json()) as { mode?: unknown };
    const mode: RoomMode = body.mode === "bot" ? "bot" : "human";
    this.mode = mode;
    if (mode === "bot") {
      this.botSeat = BOT_SEAT_INDEX;
      this.seats[BOT_SEAT_INDEX] = { name: "Bot", token: randomBase64Url(TOKEN_BYTES) };
    }
    const host = this.addPlayer("Host");
    const response: CreateRoomResponse = { roomId: this.ctx.id.toString(), hostToken: host.token };
    if (mode === "human") {
      const guest = this.addPlayer("Guest");
      response.joinToken = guest.token;
    }
    await this.persist();
    return Response.json(response, { status: 201 });
  }

  private async handleWsUpgrade(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }
    const token = new URL(request.url).searchParams.get("token");
    if (!token) {
      return new Response("missing token", { status: 401 });
    }
    const seat = this.seatForToken(token);
    if (seat === undefined) {
      return new Response("invalid token", { status: 403 });
    }
    if (seat === this.botSeat) {
      return new Response("seat reserved for bot", { status: 403 });
    }
    if (this.clientForSeat(seat) !== undefined) {
      return new Response("seat already attached", { status: 409 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({ seat } satisfies WsAttachment);
    this.ctx.acceptWebSocket(server);
    this.broadcastRoomState();
    if (this.engineState === null && this.bothSeatsFilled() && this.attachedSeatCount() === 2) {
      this.startGame(newSeed());
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const seat = this.seatForWebSocket(ws);
    if (seat === undefined) {
      ws.close();
      return;
    }
    const bucket = this.bucketFor(ws);
    if (!bucket.tryConsume()) {
      // Drop quietly to mirror gateway behavior.
      return;
    }
    const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
    let msg: ClientMessage;
    try {
      msg = parseClientMessage(JSON.parse(raw));
    } catch (err) {
      const detail = parseFailureMessage(err);
      this.send(ws, { type: "Error", code: "BAD_MESSAGE", message: detail });
      ws.close();
      return;
    }
    switch (msg.type) {
      case "JoinRoom":
        this.broadcastRoomState();
        return;
      case "LeaveRoom":
        ws.close();
        return;
      case "SubmitAction": {
        const result = this.applyAction(seat, msg.action);
        if (!result.ok) {
          const err: ErrorMessage = { type: "Error", code: result.reason, message: result.reason };
          this.send(ws, err);
        }
        await this.persist();
        return;
      }
      case "RequestRematch": {
        const result = this.requestRematch(seat);
        if (!result.ok) {
          this.send(ws, { type: "Error", code: result.reason, message: result.reason });
        }
        await this.persist();
        return;
      }
    }
  }

  override async webSocketClose(
    _ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    // Hibernation API delivers close events across wake-ups. The peer that
    // is still attached should see the vacant seat reflect, so refresh the
    // room state.
    this.broadcastRoomState();
  }

  // Test accessors. The DO public surface is fetch / WS lifecycle / alarm;
  // these methods exist solely so that tests under
  // `@cloudflare/vitest-pool-workers` can assert against engine state via
  // `runInDurableObject` without poking at private fields.
  testCurrentState(): State | null {
    return this.engineState;
  }

  testMode(): RoomMode {
    return this.mode;
  }

  testRematchSeats(): boolean[] {
    return this.rematchSeats.slice();
  }

  override async alarm(): Promise<void> {
    if (this.engineState === null || this.engineState.phase !== "in-round") return;
    const action = synthesizeTimeoutAction(this.engineState);
    if (action === null) {
      this.scheduleTurnTimer();
      return;
    }
    const result = step(this.engineState, action);
    if (!result.ok) {
      this.scheduleTurnTimer();
      return;
    }
    this.engineState = result.state;
    this.broadcast(result.events);
    this.runBotTurns();
    this.scheduleTurnTimer();
    await this.persist();
  }

  // ─── seat / token primitives ───────────────────────────────────────────

  private addPlayer(name: string): { seat: SeatIndex; token: string } {
    const seat = this.seats.indexOf(null);
    if (seat === -1) throw new Error("room is full");
    const token = randomBase64Url(TOKEN_BYTES);
    const seatIndex = seat as SeatIndex;
    this.seats[seatIndex] = { name, token };
    return { seat: seatIndex, token };
  }

  private seatForToken(token: string): SeatIndex | undefined {
    for (let i = 0; i < this.seats.length; i++) {
      const s = this.seats[i];
      if (s !== null && s !== undefined && s.token === token) return i as SeatIndex;
    }
    return undefined;
  }

  private seatForWebSocket(ws: WebSocket): SeatIndex | undefined {
    const att = ws.deserializeAttachment() as WsAttachment | null;
    return att?.seat;
  }

  private clientForSeat(seat: SeatIndex): WebSocket | undefined {
    for (const ws of this.ctx.getWebSockets()) {
      if (this.seatForWebSocket(ws) === seat) return ws;
    }
    return undefined;
  }

  private bothSeatsFilled(): boolean {
    return this.seats.every((s) => s !== null);
  }

  private attachedSeatCount(): number {
    return this.ctx.getWebSockets().length + (this.botSeat !== null ? 1 : 0);
  }

  private bucketFor(ws: WebSocket): TokenBucket {
    let bucket = this.buckets.get(ws);
    if (!bucket) {
      bucket = new TokenBucket({
        capacity: this.rateLimitCapacity,
        refillIntervalMs: DEFAULT_RATE_LIMIT.refillIntervalMs,
      });
      this.buckets.set(ws, bucket);
    }
    return bucket;
  }

  // ─── engine wiring ─────────────────────────────────────────────────────

  private startGame(seed: number): void {
    if (this.engineState !== null) throw new Error("game already started");
    if (!this.bothSeatsFilled()) throw new Error("seats not filled");
    const initial = initialState({ seed });
    const result = step(initial, { type: "START_GAME" });
    if (!result.ok) throw new Error(`START_GAME failed: ${result.reason}`);
    this.engineState = result.state;
    this.rematchSeats = new Array<boolean>(SEAT_COUNT).fill(false);
    this.broadcast(result.events);
    this.runBotTurns();
    this.scheduleTurnTimer();
    void this.persist();
  }

  private requestRematch(seat: SeatIndex): RematchResult {
    if (this.engineState === null || this.engineState.phase !== "game-over") {
      return { ok: false, reason: "REMATCH_NOT_AVAILABLE" };
    }
    if (this.rematchSeats[seat]) {
      // Idempotent — re-broadcast room state so the requester sees the
      // current pending set (e.g. after a reconnect).
      this.broadcastRoomState();
      return { ok: true };
    }
    this.rematchSeats[seat] = true;
    if (this.shouldFireRematch()) {
      this.fireRematch();
    } else {
      this.broadcastRoomState();
    }
    return { ok: true };
  }

  private shouldFireRematch(): boolean {
    // Bot seats never click rematch; bot mode fires on the human's first
    // request. Human mode requires both seats to opt in.
    if (this.mode === "bot") {
      const human = this.botSeat === 0 ? 1 : 0;
      return this.rematchSeats[human] === true;
    }
    return this.rematchSeats.every((flag) => flag === true);
  }

  private fireRematch(): void {
    this.cancelTurnTimer();
    this.engineState = null;
    this.rematchSeats = new Array<boolean>(SEAT_COUNT).fill(false);
    this.broadcastRoomState();
    this.startGame(newSeed());
  }

  private applyAction(seat: SeatIndex, action: Action): ApplyResult {
    if (this.engineState === null) {
      return { ok: false, reason: "GAME_NOT_STARTED" };
    }
    if (action.type === "START_GAME") {
      return { ok: false, reason: "FORBIDDEN_ACTION" };
    }
    if (seat === this.botSeat) {
      return { ok: false, reason: "FORBIDDEN_ACTION" };
    }
    const enforced = { ...action, by: seat };
    const result = step(this.engineState, enforced);
    if (!result.ok) return { ok: false, reason: result.reason };
    this.engineState = result.state;
    this.cancelTurnTimer();
    this.broadcast(result.events);
    this.runBotTurns();
    this.scheduleTurnTimer();
    return { ok: true, state: this.engineState, events: result.events };
  }

  private runBotTurns(): void {
    if (this.botSeat === null) return;
    for (let i = 0; i < this.botIterationCap; i++) {
      if (this.engineState === null || this.engineState.phase !== "in-round") return;
      const active = activeActorSeat(this.engineState);
      if (active !== this.botSeat) return;
      const action = bot.choose(this.engineState);
      const result = step(this.engineState, action);
      if (!result.ok) {
        this.sendErrorToHuman("BOT_ILLEGAL_ACTION", `bot rejected: ${result.reason}`);
        return;
      }
      this.engineState = result.state;
      this.broadcast(result.events);
    }
    this.sendErrorToHuman("BOT_LOOP_CAP", "bot iteration cap reached");
  }

  // ─── broadcasting ──────────────────────────────────────────────────────

  private broadcast(events: Event[]): void {
    if (this.engineState === null) return;
    const inRound = this.engineState.phase === "in-round";
    for (const ws of this.ctx.getWebSockets()) {
      const seat = this.seatForWebSocket(ws);
      if (seat === undefined) continue;
      if (inRound) {
        const snapshot = redactFor(this.engineState, seat);
        this.send(ws, { type: "Snapshot", snapshot });
      }
      if (events.length > 0) {
        this.send(ws, { type: "Events", events });
      }
    }
  }

  private broadcastRoomState(): void {
    const seats: RoomSeat[] = this.seats.map((s) => ({ name: s ? s.name : null }));
    const rematchRequested: number[] = [];
    for (let i = 0; i < this.rematchSeats.length; i++) {
      if (this.rematchSeats[i]) rematchRequested.push(i);
    }
    for (const ws of this.ctx.getWebSockets()) {
      const seat = this.seatForWebSocket(ws);
      if (seat === undefined) continue;
      const msg: RoomStateMessage = {
        type: "RoomState",
        roomId: this.ctx.id.toString(),
        seats,
        you: seat,
        rematchRequested,
      };
      this.send(ws, msg);
    }
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // socket may have closed between getWebSockets() and now; ignore.
    }
  }

  private sendErrorToHuman(code: string, message: string): void {
    if (this.botSeat === null) return;
    const humanSeat = (this.botSeat === 0 ? 1 : 0) as SeatIndex;
    const ws = this.clientForSeat(humanSeat);
    if (ws) this.send(ws, { type: "Error", code, message });
  }

  // ─── turn timer (DO Alarms) ─────────────────────────────────────────────

  private scheduleTurnTimer(): void {
    if (this.engineState === null || this.engineState.phase !== "in-round") return;
    void this.ctx.storage.setAlarm(Date.now() + this.turnTimeoutMs);
  }

  private cancelTurnTimer(): void {
    void this.ctx.storage.deleteAlarm();
  }

  private async persist(): Promise<void> {
    const snapshot: PersistedRoom = {
      mode: this.mode,
      seats: this.seats,
      engine: this.engineState,
      botSeat: this.botSeat,
      rematchSeats: this.rematchSeats.slice(),
    };
    await this.ctx.storage.put(STORAGE_KEY, snapshot);
  }
}

// ─── pure helpers ─────────────────────────────────────────────────────────

export type ApplyResult =
  | { ok: true; state: State; events: Event[] }
  | { ok: false; reason: RejectReason | "GAME_NOT_STARTED" | "FORBIDDEN_ACTION" };

export type RematchResult = { ok: true } | { ok: false; reason: "REMATCH_NOT_AVAILABLE" };

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

export function newSeed(): number {
  // RNG seeding lives outside the engine boundary (ADR-0003): the engine is
  // pure, but the host that hands seeds in is free to use platform APIs.
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return (buf[0] ?? 0) & 0x7fff_ffff;
}

export function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function parseFailureMessage(err: unknown): string {
  if (err instanceof SyntaxError) return "invalid JSON";
  if (err instanceof ZodError) return err.issues[0]?.message ?? "invalid message";
  return "invalid message";
}
