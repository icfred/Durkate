import { DurableObject } from "cloudflare:workers";
import {
  type Action,
  type BotDifficulty,
  bot,
  type Card,
  type Event,
  type GameOverState,
  type InRoundState,
  initialState,
  type RejectReason,
  type State,
  step,
} from "@durak/engine";
import {
  type ClientMessage,
  type CreateRoomResponse,
  type DisconnectState,
  type ErrorMessage,
  parseClientMessage,
  type RoomSeat,
  type RoomStateMessage,
  type ServerMessage,
} from "@durak/protocol";
import { ZodError } from "zod";
import { AlarmScheduler, type DeadlineKind, type PersistedDeadlines } from "./alarms.js";
import { computeThinkDelay, readThinkBoundsFromEnv, type ThinkBounds } from "./bot-pacing.js";
import { TokenBucket } from "./rate-limit.js";
import { redactFor } from "./redact.js";

export type SeatIndex = number;

interface Seat {
  readonly name: string;
  readonly token: string;
}

interface PersistedRoom {
  // New shape (DUR-52). When loading an older shape that still carries
  // `mode` + `botSeat`, we translate at boot.
  playerCount?: number;
  seats?: (Seat | null)[];
  engine?: State | null;
  botSeats?: SeatIndex[];
  botDifficulty?: BotDifficulty;
  rematchSeats?: boolean[];
  disconnects?: DisconnectState[];
  deadlines?: PersistedDeadlines;
  // Legacy fields kept for back-compat parsing only.
  mode?: "human" | "bot";
  botSeat?: SeatIndex | null;
  disconnect?: DisconnectState | null;
}

interface WsAttachment {
  seat: SeatIndex;
}

interface InitRequestBody {
  playerCount: number;
  botCount: number;
  difficulty?: BotDifficulty;
}

const TOKEN_BYTES = 32;
const DEFAULT_BOT_DIFFICULTY: BotDifficulty = "medium";
const DEFAULT_BOT_ITERATION_CAP = 200;
const DEFAULT_RATE_LIMIT = { capacity: 20, refillIntervalMs: 5_000 };
const STORAGE_KEY = "room";
const DEFAULT_DISCONNECT_FORFEIT_MS = 30_000;
// Room GC eviction timeouts. See apps/worker/README.md.
const ABANDONED_MS = 5 * 60 * 1000;
const IDLE_MS = 5 * 60 * 1000;
const STALE_MS = 10 * 60 * 1000;
// All-bots autoplay: when no humans remain in the active set, the bot-think
// delay is halved so the round wraps up quickly for any spectators still
// attached.
const ALL_BOTS_SPEEDUP_FACTOR = 0.5;

interface Env {
  TURN_TIMEOUT_MS?: string;
  RATE_LIMIT_CAPACITY?: string;
  DISCONNECT_FORFEIT_MS?: string;
  BOT_THINK_MIN_MS?: string;
  BOT_THINK_MAX_MS?: string;
}

export class Room extends DurableObject<Env> {
  private playerCount = 2;
  private seats: (Seat | null)[] = [null, null];
  private engineState: State | null = null;
  private botSeats: SeatIndex[] = [];
  private botDifficulty: BotDifficulty = DEFAULT_BOT_DIFFICULTY;
  private rematchSeats: boolean[] = [false, false];
  private disconnects: DisconnectState[] = [];
  private readonly turnTimeoutMs: number;
  private readonly disconnectForfeitMs: number;
  private readonly botIterationCap: number;
  private readonly rateLimitCapacity: number;
  private thinkBounds: ThinkBounds;
  private readonly alarms: AlarmScheduler;
  // Per-connection rate-limit buckets. WeakMap so hibernated sockets dropped
  // by miniflare clean up automatically; new buckets are lazily reconstructed
  // on first message after a wake-up (acceptable: a long quiet period refills
  // the bucket fully anyway).
  private readonly buckets = new WeakMap<WebSocket, TokenBucket>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.turnTimeoutMs = Number(env.TURN_TIMEOUT_MS ?? "30000");
    this.disconnectForfeitMs = Number(
      env.DISCONNECT_FORFEIT_MS ?? String(DEFAULT_DISCONNECT_FORFEIT_MS),
    );
    this.botIterationCap = DEFAULT_BOT_ITERATION_CAP;
    const capacityOverride = Number(env.RATE_LIMIT_CAPACITY ?? "");
    this.rateLimitCapacity =
      Number.isFinite(capacityOverride) && capacityOverride > 0
        ? capacityOverride
        : DEFAULT_RATE_LIMIT.capacity;
    this.thinkBounds = readThinkBoundsFromEnv(env);
    this.alarms = new AlarmScheduler(this.ctx.storage);
    void this.ctx.blockConcurrencyWhile(async () => {
      const persisted = await this.ctx.storage.get<PersistedRoom>(STORAGE_KEY);
      if (persisted) {
        this.loadPersisted(persisted);
      }
    });
  }

  private loadPersisted(persisted: PersistedRoom): void {
    if (typeof persisted.playerCount === "number") {
      this.playerCount = persisted.playerCount;
      this.seats = persisted.seats ?? new Array<Seat | null>(this.playerCount).fill(null);
      this.engineState = persisted.engine ?? null;
      this.botSeats = persisted.botSeats ?? [];
      this.botDifficulty = persisted.botDifficulty ?? DEFAULT_BOT_DIFFICULTY;
      this.rematchSeats =
        persisted.rematchSeats ?? new Array<boolean>(this.playerCount).fill(false);
      this.disconnects = persisted.disconnects ?? [];
    } else {
      // Legacy shape: pre-DUR-52 rooms with `mode` + `botSeat`. Translate.
      this.playerCount = 2;
      this.seats = persisted.seats ?? [null, null];
      this.engineState = persisted.engine ?? null;
      this.botSeats =
        persisted.botSeat !== null && persisted.botSeat !== undefined ? [persisted.botSeat] : [];
      this.botDifficulty = persisted.botDifficulty ?? DEFAULT_BOT_DIFFICULTY;
      this.rematchSeats = persisted.rematchSeats ?? [false, false];
      this.disconnects = persisted.disconnect ? [persisted.disconnect] : [];
    }
    this.alarms.load(persisted.deadlines);
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
    const body = (await request.json()) as Partial<InitRequestBody>;
    const playerCount = Number(body.playerCount);
    const botCount = Number(body.botCount);
    if (
      !Number.isInteger(playerCount) ||
      playerCount < 2 ||
      playerCount > 6 ||
      !Number.isInteger(botCount) ||
      botCount < 0 ||
      botCount >= playerCount
    ) {
      return new Response("invalid init body", { status: 400 });
    }
    this.playerCount = playerCount;
    this.seats = new Array<Seat | null>(playerCount).fill(null);
    this.rematchSeats = new Array<boolean>(playerCount).fill(false);
    this.botDifficulty = parseDifficulty(body.difficulty);
    // Bots fill seats from the back so seat 0 stays human (the host).
    this.botSeats = [];
    for (let i = 0; i < botCount; i++) {
      const seatIndex = (playerCount - 1 - i) as SeatIndex;
      this.botSeats.push(seatIndex);
      this.seats[seatIndex] = {
        name: `Bot ${botCount - i}`,
        token: randomBase64Url(TOKEN_BYTES),
      };
    }
    this.botSeats.sort((a, b) => a - b);
    const host = this.addPlayer("Host");
    const joinTokens: string[] = [];
    const remainingHumans = playerCount - botCount - 1;
    for (let i = 0; i < remainingHumans; i++) {
      const guest = this.addPlayer(`Guest ${i + 1}`);
      joinTokens.push(guest.token);
    }
    const response: CreateRoomResponse = {
      roomId: this.ctx.id.toString(),
      hostToken: host.token,
      joinTokens,
    };
    if (joinTokens.length === 1) response.joinToken = joinTokens[0];
    // Schedule abandoned-on-create eviction. The first ws attach cancels it.
    this.alarms.schedule("abandoned", Date.now() + ABANDONED_MS);
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
    if (this.botSeats.includes(seat)) {
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
    // Any attach cancels both abandoned-on-create and idle eviction. They're
    // re-scheduled on close if appropriate.
    this.alarms.cancel("abandoned");
    this.alarms.cancel("idle");
    const wasDisconnected = this.removeDisconnect(seat);
    if (wasDisconnected) {
      this.refreshForfeitAlarm();
      await this.persist();
    }
    this.broadcastRoomState();
    if (
      this.engineState === null &&
      this.allSeatsFilled() &&
      this.attachedSeatCount() === this.playerCount
    ) {
      this.startGame(newSeed());
    } else if (this.engineState !== null && this.engineState.phase === "in-round") {
      // Mid-game reconnect: replay the current state to the rejoining seat
      // so they don't have to wait for the next event to render. Re-arm the
      // turn timer in case it was paused while the room was unattended.
      this.sendCurrentState(server, seat);
      this.scheduleTurnTimer();
      await this.persist();
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
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    // Hibernation API delivers close events across wake-ups. The remaining
    // attached peers should see the vacant seat reflect, so refresh the
    // room state.
    const seat = this.seatForWebSocket(ws);
    if (
      seat !== undefined &&
      !this.botSeats.includes(seat) &&
      this.engineState !== null &&
      this.engineState.phase === "in-round" &&
      !this.isDisconnected(seat) &&
      !this.isEngineEliminated(seat)
    ) {
      const forfeitAt = Date.now() + this.disconnectForfeitMs;
      this.disconnects.push({ seat, forfeitAt });
      this.refreshForfeitAlarm();
      await this.persist();
    }
    if (this.ctx.getWebSockets().length === 0 && this.engineState?.phase !== "game-over") {
      this.cancelTurnTimer();
      if (!this.alarms.has("idle")) {
        this.alarms.schedule("idle", Date.now() + IDLE_MS);
      }
      await this.persist();
    }
    this.broadcastRoomState();
  }

  // Test accessors. The DO public surface is fetch / WS lifecycle / alarm;
  // these methods exist solely so that tests under
  // `@cloudflare/vitest-pool-workers` can assert against engine state via
  // `runInDurableObject` without poking at private fields.
  testCurrentState(): State | null {
    return this.engineState;
  }

  testPlayerCount(): number {
    return this.playerCount;
  }

  testBotSeats(): SeatIndex[] {
    return this.botSeats.slice();
  }

  testRematchSeats(): boolean[] {
    return this.rematchSeats.slice();
  }

  override async alarm(): Promise<void> {
    const fired = this.alarms.due(Date.now());
    if (fired.length === 0) return;
    if (await this.dispatchFired(fired)) await this.persist();
  }

  // Test seam: simulate alarm firing with `now` overridden so tests don't
  // depend on wall-clock advancement. Returns the kinds that fired.
  async testFireAlarm(now: number): Promise<DeadlineKind[]> {
    const fired = this.alarms.due(now);
    if (await this.dispatchFired(fired)) await this.persist();
    return fired;
  }

  // Test seam: legacy single-disconnect accessor. Returns the earliest
  // pending disconnect (or null) so existing single-disconnect tests work.
  testDisconnect(): DisconnectState | null {
    return this.earliestDisconnect();
  }

  testDisconnects(): DisconnectState[] {
    return this.disconnects.map((d) => ({ ...d }));
  }

  // Test seam: read the current deadline map so tests can assert which
  // GC / forfeit / turn deadlines are armed.
  testDeadlines(): PersistedDeadlines {
    return this.alarms.toPersisted();
  }

  // Test seam: re-arm the bot driver from outside so tests can probe the
  // post-elimination scheduling cadence (all-bots autoplay 2x).
  testArmBotTurn(): void {
    this.alarms.cancel("bot-think");
    this.armBotTurnIfNeeded();
  }

  // Test seam: read the all-bots-active flag the way the room sees it.
  testAllBotsActive(): boolean {
    return this.allBotsActive();
  }

  // Test seam: synthesize a hand-empty for the given seat so tests can
  // exercise spectator semantics without grinding to game-over by hand.
  testEliminateSeat(seat: SeatIndex): void {
    if (this.engineState === null || this.engineState.phase !== "in-round") return;
    const hand = this.engineState.hands[seat] ?? [];
    if (hand.length === 0) return;
    const next: InRoundState = {
      ...this.engineState,
      hands: this.engineState.hands.map((h, i) => (i === seat ? [] : h)),
      discard: [...this.engineState.discard, ...hand],
      // Drain talon and trumpCard so engine recognizes the seat as
      // eliminated immediately (its eliminatedSeatsOf check requires
      // talon === [] and trumpCard === null).
      talon: [],
      trumpCard: null,
    };
    this.engineState = next;
  }

  private async dispatchFired(fired: DeadlineKind[]): Promise<boolean> {
    let mutated = false;
    for (const kind of fired) {
      if (kind === "turn-timeout") {
        if (this.handleTurnTimeout()) mutated = true;
      } else if (kind === "forfeit") {
        if (this.handleForfeit()) mutated = true;
      } else if (kind === "bot-think") {
        if (this.handleBotThink()) mutated = true;
      } else if (kind === "abandoned" || kind === "idle" || kind === "stale") {
        await this.evict(kind);
        // evict deletes all storage so we don't persist after.
        return false;
      } else {
        kind satisfies never;
      }
    }
    return mutated;
  }

  // Hard delete: clear DO storage and in-memory state. After this returns
  // the DO can be hibernated and re-instantiated; loading from empty
  // storage produces a fresh, uninitialized room (which `handleInit` will
  // refuse since `seats.some(s => s !== null)` is false but a re-init is
  // fine: any lingering ws-upgrade attempt with an old token returns 403).
  private async evict(reason: "abandoned" | "idle" | "stale"): Promise<void> {
    console.info(
      `[room] evicted (${reason}) roomId=${this.ctx.id.toString()} playerCount=${this.playerCount} botSeats=${this.botSeats.join(",")}`,
    );
    this.engineState = null;
    this.seats = new Array<Seat | null>(this.playerCount).fill(null);
    this.botSeats = [];
    this.rematchSeats = new Array<boolean>(this.playerCount).fill(false);
    this.disconnects = [];
    // Clear all alarm bookkeeping before deleteAll wipes the persisted map.
    this.alarms.cancel("turn-timeout");
    this.alarms.cancel("forfeit");
    this.alarms.cancel("abandoned");
    this.alarms.cancel("idle");
    this.alarms.cancel("stale");
    this.alarms.cancel("bot-think");
    await this.ctx.storage.deleteAll();
  }

  // Schedule (or refresh) the stale-finished eviction iff the engine has
  // entered game-over. Cancel it otherwise. Called after every action /
  // rematch / forfeit so phase transitions are tracked centrally. Also
  // tears down the turn timer and any pending bot-think alarm — once the
  // game is over neither has anything to act on.
  private bumpStaleIfFinished(): void {
    if (this.engineState !== null && this.engineState.phase === "game-over") {
      this.alarms.cancel("turn-timeout");
      this.alarms.cancel("bot-think");
      this.alarms.cancel("forfeit");
      this.disconnects = [];
      this.botChainCount = 0;
      if (!this.alarms.has("stale")) {
        this.alarms.schedule("stale", Date.now() + STALE_MS);
      }
    } else {
      this.alarms.cancel("stale");
    }
  }

  private handleTurnTimeout(): boolean {
    if (this.engineState === null || this.engineState.phase !== "in-round") return false;
    const action = synthesizeTimeoutAction(this.engineState);
    if (action === null) {
      this.advancePastEliminatedActor();
      this.scheduleTurnTimer();
      return false;
    }
    const result = step(this.engineState, action);
    if (!result.ok) {
      this.scheduleTurnTimer();
      return false;
    }
    this.engineState = result.state;
    this.broadcast(result.events);
    this.scheduleTurnTimer();
    this.armBotTurnIfNeeded();
    this.bumpStaleIfFinished();
    return true;
  }

  // Forfeit at N>2 ends the round with the forfeiter as durak. Multi-seat
  // forfeit-as-elimination would need engine cooperation (mid-round skip
  // of a seat without legal cards) and is out of scope here. Documented
  // in apps/worker/README.md.
  //
  // Called by the alarm dispatcher when the earliest `forfeitAt` is past;
  // we trust the alarm contract (the scheduler only fires the kind once
  // its deadline elapsed) rather than re-comparing wall-clock time, so the
  // test seam `testFireAlarm(fakeNow)` works without injecting time into
  // this method.
  private handleForfeit(): boolean {
    if (this.engineState === null || this.engineState.phase !== "in-round") {
      this.disconnects = [];
      return true;
    }
    if (this.disconnects.length === 0) return false;
    // Earliest pending disconnect becomes the durak. Tie-break by seat for
    // determinism when two seats disconnect at the same instant.
    const sorted = [...this.disconnects].sort(
      (a, b) => a.forfeitAt - b.forfeitAt || a.seat - b.seat,
    );
    const first = sorted[0] as DisconnectState;
    const seat = first.seat;
    const forfeit = forfeitState(this.engineState, seat);
    this.engineState = forfeit;
    this.disconnects = [];
    this.alarms.cancel("turn-timeout");
    this.alarms.cancel("bot-think");
    this.alarms.cancel("forfeit");
    this.botChainCount = 0;
    this.broadcast([{ type: "GAME_OVER", durak: seat }]);
    this.broadcastRoomState();
    this.bumpStaleIfFinished();
    return true;
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

  private allSeatsFilled(): boolean {
    return this.seats.every((s) => s !== null);
  }

  // Count of seats that are "logically attached": connected human ws
  // sockets plus reserved bot seats (which are always considered present).
  private attachedSeatCount(): number {
    return this.ctx.getWebSockets().length + this.botSeats.length;
  }

  private isDisconnected(seat: SeatIndex): boolean {
    return this.disconnects.some((d) => d.seat === seat);
  }

  private removeDisconnect(seat: SeatIndex): boolean {
    const before = this.disconnects.length;
    this.disconnects = this.disconnects.filter((d) => d.seat !== seat);
    return this.disconnects.length !== before;
  }

  private earliestDisconnect(): DisconnectState | null {
    if (this.disconnects.length === 0) return null;
    let earliest = this.disconnects[0] as DisconnectState;
    for (const d of this.disconnects) {
      if (d.forfeitAt < earliest.forfeitAt) earliest = d;
    }
    return { ...earliest };
  }

  private refreshForfeitAlarm(): void {
    const earliest = this.earliestDisconnect();
    if (earliest === null) {
      this.alarms.cancel("forfeit");
    } else {
      this.alarms.schedule("forfeit", earliest.forfeitAt);
    }
  }

  private isEngineEliminated(seat: SeatIndex): boolean {
    if (this.engineState === null || this.engineState.phase !== "in-round") return false;
    return eliminatedSeatsOfState(this.engineState).has(seat);
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
    if (!this.allSeatsFilled()) throw new Error("seats not filled");
    const initial = initialState({ seed, playerCount: this.playerCount });
    const result = step(initial, { type: "START_GAME" });
    if (!result.ok) throw new Error(`START_GAME failed: ${result.reason}`);
    this.engineState = result.state;
    this.rematchSeats = new Array<boolean>(this.playerCount).fill(false);
    this.broadcast(result.events);
    this.scheduleTurnTimer();
    this.armBotTurnIfNeeded();
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
    // Bots never request rematch. The trigger is "every human seat opted
    // in" — the rematch fires once all non-bot seats have flipped their
    // flag. In a pure-vs-bot room this means the host's first request.
    for (let s = 0; s < this.playerCount; s++) {
      if (this.botSeats.includes(s)) continue;
      if (!this.rematchSeats[s]) return false;
    }
    return true;
  }

  private fireRematch(): void {
    this.cancelTurnTimer();
    this.alarms.cancel("stale");
    this.alarms.cancel("bot-think");
    this.botChainCount = 0;
    this.engineState = null;
    this.rematchSeats = new Array<boolean>(this.playerCount).fill(false);
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
    if (this.botSeats.includes(seat)) {
      return { ok: false, reason: "FORBIDDEN_ACTION" };
    }
    if (this.engineState.phase === "in-round" && this.isEngineEliminated(seat)) {
      return { ok: false, reason: "FORBIDDEN_ACTION" };
    }
    const enforced = { ...action, by: seat };
    const result = step(this.engineState, enforced);
    if (!result.ok) return { ok: false, reason: result.reason };
    this.engineState = result.state;
    this.cancelTurnTimer();
    this.broadcast(result.events);
    this.advancePastEliminatedActor();
    this.armBotTurnIfNeeded();
    this.scheduleTurnTimer();
    this.bumpStaleIfFinished();
    return { ok: true, state: this.engineState, events: result.events };
  }

  // Engine-level edge case at N>2: a seat can play its last card mid-round
  // (PLAYER_OUT) while still being `state.attacker`. After the round finishes
  // resolving (defender's reaction), `activeActorSeat` would point at the
  // eliminated attacker — neither the human (rejected) nor the bot driver
  // (skips eliminated) can advance the game. Synthesize a TIMEOUT for them
  // here; the engine resolves it as END_ROUND/TAKE_PILE which then runs
  // `rotateRoles` and skips the eliminated seat correctly.
  private advancePastEliminatedActor(): void {
    if (this.engineState === null || this.engineState.phase !== "in-round") return;
    for (let i = 0; i < this.playerCount * 2 && this.engineState.phase === "in-round"; i++) {
      const active = activeActorSeat(this.engineState);
      const eliminated = eliminatedSeatsOfState(this.engineState);
      if (!eliminated.has(active)) break;
      const result = step(this.engineState, { type: "TIMEOUT", by: active });
      if (!result.ok) break;
      this.engineState = result.state;
      this.broadcast(result.events);
    }
  }

  // Single bot iteration counter, reset whenever a non-bot move lands. The
  // counter exists to bound runaway alarm chains (every fire schedules the
  // next), echoing the old synchronous loop's botIterationCap. Reset by the
  // engine reaching a phase change or a non-bot active seat.
  private botChainCount = 0;

  // If the active seat is a bot, schedule a `bot-think` alarm and announce
  // the thinking seat to clients via RoomState. Otherwise clears any
  // outstanding bot-think state. Idempotent — safe to call after every
  // engine transition.
  private armBotTurnIfNeeded(): void {
    if (this.botSeats.length === 0) {
      this.botChainCount = 0;
      this.clearThinkingState();
      return;
    }
    if (this.engineState === null || this.engineState.phase !== "in-round") {
      this.botChainCount = 0;
      this.clearThinkingState();
      return;
    }
    const active = activeActorSeat(this.engineState);
    if (!this.botSeats.includes(active)) {
      this.botChainCount = 0;
      this.clearThinkingState();
      return;
    }
    if (this.botChainCount >= this.botIterationCap) {
      this.botChainCount = 0;
      this.clearThinkingState();
      this.sendErrorToHumans("BOT_LOOP_CAP", "bot iteration cap reached");
      return;
    }
    this.botChainCount += 1;
    const baseDelay = computeThinkDelay({
      state: this.engineState,
      seat: active,
      difficulty: this.botDifficulty,
      bounds: this.thinkBounds,
    });
    if (baseDelay <= 0) {
      // Pacing disabled (env override) — fall back to synchronous play so
      // tests that rely on instant bot turns keep their existing shape.
      const moved = this.runBotMoveNow();
      if (moved) {
        this.scheduleTurnTimer();
        this.bumpStaleIfFinished();
        this.armBotTurnIfNeeded();
      }
      return;
    }
    const delay = this.allBotsActive()
      ? Math.round(baseDelay * ALL_BOTS_SPEEDUP_FACTOR)
      : baseDelay;
    this.alarms.schedule("bot-think", Date.now() + delay);
    this.broadcastRoomState();
  }

  // True iff every seat still in the round (non-eliminated) is a bot.
  // Drives the all-bots autoplay 2x speedup: once humans are spectators,
  // bot-think delay is halved so the round wraps up quickly.
  private allBotsActive(): boolean {
    if (this.engineState === null || this.engineState.phase !== "in-round") return false;
    const eliminated = eliminatedSeatsOfState(this.engineState);
    for (let s = 0; s < this.playerCount; s++) {
      if (eliminated.has(s)) continue;
      if (!this.botSeats.includes(s)) return false;
    }
    return true;
  }

  private clearThinkingState(): void {
    if (this.alarms.has("bot-think")) {
      this.alarms.cancel("bot-think");
      this.broadcastRoomState();
    }
  }

  // Alarm handler: run one bot move, then reschedule if still the bot's
  // turn. Caller (`dispatchFired`) calls `persist()` afterwards when this
  // returns true.
  private handleBotThink(): boolean {
    if (this.botSeats.length === 0) return false;
    if (this.engineState === null || this.engineState.phase !== "in-round") {
      this.botChainCount = 0;
      this.broadcastRoomState();
      return true;
    }
    const active = activeActorSeat(this.engineState);
    if (!this.botSeats.includes(active)) {
      this.botChainCount = 0;
      this.broadcastRoomState();
      return true;
    }
    // Clear thinking before running the move so the broadcast in the move
    // doesn't carry stale `thinkingSeats`.
    this.broadcastRoomState();
    const moved = this.runBotMoveNow();
    if (!moved) return true;
    this.scheduleTurnTimer();
    this.armBotTurnIfNeeded();
    this.bumpStaleIfFinished();
    return true;
  }

  // Synchronously runs one bot.choose -> step. Returns true if a move
  // landed. Used by the alarm handler and by the zero-delay fast path.
  private runBotMoveNow(): boolean {
    if (this.botSeats.length === 0) return false;
    if (this.engineState === null || this.engineState.phase !== "in-round") return false;
    const active = activeActorSeat(this.engineState);
    if (!this.botSeats.includes(active)) return false;
    const action = bot.choose(this.engineState, { difficulty: this.botDifficulty });
    const result = step(this.engineState, action);
    if (!result.ok) {
      this.sendErrorToHumans("BOT_ILLEGAL_ACTION", `bot rejected: ${result.reason}`);
      return false;
    }
    this.engineState = result.state;
    this.broadcast(result.events);
    this.advancePastEliminatedActor();
    return true;
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
    const earliest = this.earliestDisconnect();
    const disconnects = this.disconnects.map((d) => ({ ...d }));
    const thinkingSeats: SeatIndex[] = this.computeThinkingSeats();
    const eliminated: SeatIndex[] =
      this.engineState !== null && this.engineState.phase === "in-round"
        ? Array.from(eliminatedSeatsOfState(this.engineState)).sort((a, b) => a - b)
        : [];
    for (const ws of this.ctx.getWebSockets()) {
      const seat = this.seatForWebSocket(ws);
      if (seat === undefined) continue;
      const msg: RoomStateMessage = {
        type: "RoomState",
        roomId: this.ctx.id.toString(),
        seats,
        you: seat,
        rematchRequested,
        disconnect: earliest,
        disconnects,
        thinkingSeats,
        eliminated,
      };
      this.send(ws, msg);
    }
  }

  private computeThinkingSeats(): SeatIndex[] {
    if (!this.alarms.has("bot-think")) return [];
    if (this.engineState === null || this.engineState.phase !== "in-round") return [];
    const active = activeActorSeat(this.engineState);
    if (!this.botSeats.includes(active)) return [];
    return [active];
  }

  // Replays the current engine state to a single WS so a rejoining seat
  // lands directly back in the in-round screen instead of waiting for the
  // next event.
  private sendCurrentState(ws: WebSocket, seat: SeatIndex): void {
    if (this.engineState === null || this.engineState.phase !== "in-round") return;
    const snapshot = redactFor(this.engineState, seat);
    this.send(ws, { type: "Snapshot", snapshot });
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // socket may have closed between getWebSockets() and now; ignore.
    }
  }

  private sendErrorToHumans(code: string, message: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      const seat = this.seatForWebSocket(ws);
      if (seat === undefined) continue;
      if (this.botSeats.includes(seat)) continue;
      this.send(ws, { type: "Error", code, message });
    }
  }

  // ─── turn timer (DO Alarms) ─────────────────────────────────────────────

  private scheduleTurnTimer(): void {
    if (this.engineState === null || this.engineState.phase !== "in-round") return;
    this.alarms.schedule("turn-timeout", Date.now() + this.turnTimeoutMs);
  }

  private cancelTurnTimer(): void {
    this.alarms.cancel("turn-timeout");
  }

  private async persist(): Promise<void> {
    const snapshot: PersistedRoom = {
      playerCount: this.playerCount,
      seats: this.seats,
      engine: this.engineState,
      botSeats: this.botSeats.slice(),
      botDifficulty: this.botDifficulty,
      rematchSeats: this.rematchSeats.slice(),
      disconnects: this.disconnects.map((d) => ({ ...d })),
      deadlines: this.alarms.toPersisted(),
    };
    await this.ctx.storage.put(STORAGE_KEY, snapshot);
  }

  testBotDifficulty(): BotDifficulty {
    return this.botDifficulty;
  }

  // Test seam: override the bot pacing bounds without rebooting the DO.
  // Production code reads them from env once in the constructor; tests
  // toggle them per-case to exercise the alarm path.
  testSetThinkBounds(bounds: ThinkBounds): void {
    this.thinkBounds = bounds;
  }

  testThinkBounds(): ThinkBounds {
    return this.thinkBounds;
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

// Builds a `GameOverState` declaring `durak` as the loser. ADR-0009: the
// forfeit transition lives in the worker, not the engine, since the
// trigger is network state. The shape mirrors what `finalizeRoundEnd`
// produces in `packages/engine/src/step.ts` so the client receives the
// same protocol contract.
export function forfeitState(state: InRoundState, durak: number): GameOverState {
  return {
    phase: "game-over",
    playerCount: state.playerCount,
    rng: state.rng,
    hands: state.hands,
    trumpSuit: state.trumpSuit,
    trumpCard: state.trumpCard,
    discard: state.discard,
    durak,
  };
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

function parseDifficulty(raw: unknown): BotDifficulty {
  if (raw === "easy" || raw === "medium" || raw === "hard") return raw;
  return DEFAULT_BOT_DIFFICULTY;
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

// Mirrors the engine's internal `eliminatedSeatsOf` (not exported). A seat
// is eliminated once its hand is empty AND no replenishment is possible
// (talon empty + trumpCard null). The engine emits `PLAYER_OUT` events on
// the same transition.
function eliminatedSeatsOfState(state: {
  hands: readonly (readonly Card[])[];
  talon: readonly Card[];
  trumpCard: Card | null;
}): Set<number> {
  if (state.talon.length > 0 || state.trumpCard !== null) return new Set();
  const out = new Set<number>();
  for (let i = 0; i < state.hands.length; i++) {
    if ((state.hands[i] as readonly Card[]).length === 0) out.add(i);
  }
  return out;
}
