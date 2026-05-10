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
  type MatchState,
  type PendingCloseState,
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
  /**
   * Room-level invite token. Any human upgrading the WS with this token
   * claims the next available seat. Distinct from per-seat tokens (which
   * land in `seats[].token` after the swap). Persisted so reload after
   * DO hibernation re-issues the same share link.
   */
  inviteToken?: string | null;
  pendingClose?: PendingCloseState | null;
  pendingCloseBy?: SeatIndex | null;
  botFanOut?: { seat: SeatIndex; at: number }[];
  lobbyHold?: boolean;
  totalRounds?: number;
  currentRound?: number;
  scores?: number[];
  matchOver?: boolean;
  finishOrder?: number[];
  // Per-seat bot difficulty. `null` for human seats. Array length
  // tracks `playerCount`. Older persisted snapshots (pre-DUR-62) only
  // carried `botDifficulty` as a single value — `loadPersisted` fills
  // every bot seat with that single value when migrating.
  botDifficulties?: (BotDifficulty | null)[];
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
  /**
   * Hold the room in lobby until the host signals ready via the
   * `StartGame` client message. Bot seats are still pre-allocated (so
   * the lobby UI shows their names) and the bot-seat tokens are
   * surfaced as `joinTokens` so the host can share them — anyone who
   * connects with a bot-seat token replaces that bot.
   */
  lobbyHold?: boolean;
  /**
   * Best-of-N rounds. Defaults to 1 (single game, legacy semantics).
   * Capped at 9 by the protocol layer.
   */
  rounds?: number;
}

const TOKEN_BYTES = 32;
const DEFAULT_BOT_DIFFICULTY: BotDifficulty = "medium";
const DEFAULT_BOT_ITERATION_CAP = 200;
const DEFAULT_RATE_LIMIT = { capacity: 20, refillIntervalMs: 5_000 };
const STORAGE_KEY = "room";
const DEFAULT_DISCONNECT_FORFEIT_MS = 30_000;
// FFA throw-in window default (ADR-0011). At N=2 the window collapses to
// 0 — the only non-defender is the attacker, who already had every chance
// to throw in before submitting the round-resolving action.
const DEFAULT_CLOSE_WINDOW_MS = 2_500;
// Room GC eviction timeouts. See apps/worker/README.md.
const ABANDONED_MS = 5 * 60 * 1000;
// Bumped from 5 → 15 minutes. With a bot opponent the human's WS is the
// only one in the room, so any tab disconnect (sleep, throttle, blip)
// disarms `idle` only on the immediate reconnect — a 5-minute window was
// too tight and routinely evicted live games people stepped away from.
const IDLE_MS = 15 * 60 * 1000;
const STALE_MS = 10 * 60 * 1000;
// Close code emitted to attached WSes when the DO is evicted. Clients
// detect it and route the user back to the main menu instead of getting
// stuck on the game screen with `GAME_NOT_STARTED` rejections.
const CLOSE_CODE_ROOM_EXPIRED = 4404;
// All-bots autoplay: when no humans remain in the active set, the bot-think
// delay is halved so the round wraps up quickly for any spectators still
// attached.
const ALL_BOTS_SPEEDUP_FACTOR = 0.5;

// Bot display names. Russian-themed because Durak is a Russian card game,
// but kept short and recognisable so they read clearly in a 6-seat
// opponent layout. Chosen at room creation, no duplicates within a room.
const BOT_NAMES: readonly string[] = [
  "Anya",
  "Boris",
  "Dima",
  "Elena",
  "Fyodor",
  "Galina",
  "Igor",
  "Katya",
  "Lev",
  "Misha",
  "Nadia",
  "Olga",
  "Pavel",
  "Raisa",
  "Sasha",
  "Tanya",
  "Vera",
  "Yuri",
  "Zoya",
  "Maxim",
];

interface Env {
  TURN_TIMEOUT_MS?: string;
  RATE_LIMIT_CAPACITY?: string;
  DISCONNECT_FORFEIT_MS?: string;
  BOT_THINK_MIN_MS?: string;
  BOT_THINK_MAX_MS?: string;
  CLOSE_WINDOW_MS?: string;
}

export class Room extends DurableObject<Env> {
  private playerCount = 2;
  private seats: (Seat | null)[] = [null, null];
  private engineState: State | null = null;
  private botSeats: SeatIndex[] = [];
  private botDifficulty: BotDifficulty = DEFAULT_BOT_DIFFICULTY;
  // Per-seat bot difficulty. Indexed by seat; `null` for human seats.
  // Initialized at room create from the request's `difficulty` (single
  // value applied to all bot seats) and mutated per-seat by the host
  // via the `SetBotDifficulty` ws action while the room is in lobby.
  private botDifficulties: (BotDifficulty | null)[] = [];
  private rematchSeats: boolean[] = [false, false];
  private disconnects: DisconnectState[] = [];
  // Single shareable invite token. Set in `handleInit`; any human who
  // upgrades the WS with this token claims the first available bot or
  // null seat (lobbyHold-only) and gets a per-seat token issued via the
  // `SessionAssigned` server message for reconnects. Replaces the
  // per-seat-token-as-invite scheme that surfaced N tokens to the host.
  private inviteToken: string | null = null;
  // Best-of-N match state. `totalRounds === 1` means legacy single-game
  // behaviour: rematch resets via the existing flow, no inter-round
  // screen. For `totalRounds > 1` the host advances rounds via the
  // `StartGame` ws message after each game-over, with `scores[seat]`
  // accumulating position-based points across the match.
  private totalRounds = 1;
  private currentRound = 1;
  private scores: number[] = [];
  private matchOver = false;
  // True once the current round's durak has been recorded into `scores`.
  // Resets when the next round starts. Prevents double-counting if
  // `bumpStaleIfFinished` is called multiple times while in game-over.
  private currentRoundScored = false;
  // Order in which seats are eliminated via PLAYER_OUT events during the
  // current round. Seat at index 0 = first out (winner), etc. The durak
  // is not appended here — handled separately in recordRoundResult.
  // Persisted so DO hibernation mid-round doesn't lose the ordering.
  private finishOrder: SeatIndex[] = [];
  // FFA throw-in window (ADR-0011). When non-null, the engine has not yet
  // applied the stored kind — it sits behind a `close-window` alarm that
  // fires after `closesAt`. THROW_IN extends, PASS appends, every active
  // non-defender passing fires the close immediately.
  private pendingClose: PendingCloseState | null = null;
  // The seat that originally submitted the round-resolving action. We
  // re-issue the action from the original `by` so the engine's
  // attacker/defender legality checks still pass when the alarm fires.
  private pendingCloseBy: SeatIndex | null = null;
  // Per-seat bot-think deadlines for the fan-out during `pendingClose`.
  // Empty outside the window; arming this composes with the existing
  // single-actor `bot-think` slot via `armBotTurnIfNeeded`.
  private botFanOut: Map<SeatIndex, number> = new Map();
  // Mid-round throw-in queued for the next `bot-think` fire. Set when
  // `armBotTurnIfNeeded` finds a non-attacker non-defender bot with a
  // matching-rank card (FFA pile-on, ADR-0010). `runBotMoveNow` consumes
  // it ahead of the active actor's normal `bot.choose`. Cleared on
  // game-over / rematch / forfeit so it doesn't leak across rounds.
  private pendingThrowIn: { seat: SeatIndex; card: Card } | null = null;
  // FFA lobby hold: when true the room won't auto-start even with all
  // seats filled. The host sends `StartGame` to release. Bot-seat
  // tokens are exposed in `joinTokens` while held so a friend joining
  // via the share link can swap into a bot's slot.
  private lobbyHold = false;
  private readonly turnTimeoutMs: number;
  private readonly disconnectForfeitMs: number;
  private closeWindowMs: number;
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
    const closeWindowRaw = env.CLOSE_WINDOW_MS;
    const closeWindowOverride =
      closeWindowRaw && closeWindowRaw.length > 0 ? Number(closeWindowRaw) : NaN;
    this.closeWindowMs =
      Number.isFinite(closeWindowOverride) && closeWindowOverride >= 0
        ? closeWindowOverride
        : DEFAULT_CLOSE_WINDOW_MS;
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
    this.pendingClose = persisted.pendingClose ?? null;
    this.pendingCloseBy = persisted.pendingCloseBy ?? null;
    this.botFanOut = new Map(
      (persisted.botFanOut ?? []).map((entry) => [entry.seat, entry.at] as const),
    );
    this.lobbyHold = persisted.lobbyHold ?? false;
    // Per-seat difficulties. Migration path for pre-DUR-62 snapshots:
    // if `botDifficulties` is missing, fall back to the single
    // `botDifficulty` (or DEFAULT) for every bot seat.
    if (persisted.botDifficulties && persisted.botDifficulties.length === this.playerCount) {
      this.botDifficulties = persisted.botDifficulties.slice();
    } else {
      this.botDifficulties = new Array<BotDifficulty | null>(this.playerCount).fill(null);
      for (const seat of this.botSeats) {
        this.botDifficulties[seat] = this.botDifficulty;
      }
    }
    this.totalRounds = persisted.totalRounds ?? 1;
    this.currentRound = persisted.currentRound ?? 1;
    this.scores = persisted.scores ?? new Array<number>(this.playerCount).fill(0);
    if (this.scores.length !== this.playerCount) {
      this.scores = new Array<number>(this.playerCount).fill(0);
    }
    this.matchOver = persisted.matchOver ?? false;
    this.finishOrder = (persisted.finishOrder ?? []) as SeatIndex[];
    this.inviteToken = persisted.inviteToken ?? null;
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
    this.botDifficulties = new Array<BotDifficulty | null>(playerCount).fill(null);
    this.lobbyHold = body.lobbyHold === true;
    const requestedRounds = Number(body.rounds);
    this.totalRounds =
      Number.isInteger(requestedRounds) && requestedRounds >= 1 && requestedRounds <= 9
        ? requestedRounds
        : 1;
    this.currentRound = 1;
    this.scores = new Array<number>(playerCount).fill(0);
    this.matchOver = false;
    // Bots fill seats from the back so seat 0 stays human (the host).
    // Pick distinct display names from the pool so no two bots in the
    // room share a name (avoids the confusing "× 5 vs Bot 1" UI).
    this.botSeats = [];
    const names = pickBotNames(botCount);
    for (let i = 0; i < botCount; i++) {
      const seatIndex = (playerCount - 1 - i) as SeatIndex;
      this.botSeats.push(seatIndex);
      this.seats[seatIndex] = {
        name: names[i] ?? `Bot ${botCount - i}`,
        token: randomBase64Url(TOKEN_BYTES),
      };
      this.botDifficulties[seatIndex] = this.botDifficulty;
    }
    this.botSeats.sort((a, b) => a - b);
    const host = this.addPlayer("Host");
    const remainingHumans = playerCount - botCount - 1;
    // Non-host human seats are NOT pre-allocated. They stay null until an
    // invitee claims them via the room-level inviteToken; that's the only
    // way to seat additional humans now.
    //
    // Single shareable invite token. Any human upgrading the WS with this
    // claims the next available bot/null seat and the server replies with
    // `SessionAssigned` carrying the per-seat token for reconnects.
    // Only minted when at least one seat is claimable by a future human
    // (lobbyHold or any non-host human seats); pure bot rooms get none.
    const exposesInviteToken = this.lobbyHold || remainingHumans > 0;
    this.inviteToken = exposesInviteToken ? randomBase64Url(TOKEN_BYTES) : null;
    const joinTokens = this.inviteToken ? [this.inviteToken] : [];
    const response: CreateRoomResponse = {
      roomId: this.ctx.id.toString(),
      hostToken: host.token,
      joinTokens,
    };
    if (this.inviteToken) response.joinToken = this.inviteToken;
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

    let seat = this.seatForToken(token);
    let issuedToken: string | null = null;

    if (seat === undefined) {
      // Per-seat token miss — try the room-level invite token. Picks the
      // first available bot/null seat, mints a fresh per-seat token, and
      // hands it back over the WS via SessionAssigned so the client can
      // persist for reconnects.
      if (this.inviteToken === null || token !== this.inviteToken) {
        return new Response("invalid token", { status: 403 });
      }
      if (this.engineState !== null && !this.lobbyHold) {
        return new Response("game already started", { status: 403 });
      }
      const claimable = this.firstClaimableSeat();
      if (claimable === null) {
        return new Response("no seats available", { status: 403 });
      }
      issuedToken = randomBase64Url(TOKEN_BYTES);
      if (this.botSeats.includes(claimable)) {
        // Swap out the bot.
        this.botSeats = this.botSeats.filter((s) => s !== claimable);
        if (claimable < this.botDifficulties.length) this.botDifficulties[claimable] = null;
        this.alarms.cancel("bot-think");
        this.botFanOut.delete(claimable);
      }
      this.seats[claimable] = { name: "Guest", token: issuedToken };
      seat = claimable;
      await this.persist();
      this.broadcastRoomState();
    } else if (this.botSeats.includes(seat)) {
      // Legacy compat: per-seat token belonging to a bot seat (rooms
      // created before the inviteToken scheme). Same swap behaviour.
      if (!this.lobbyHold || this.engineState !== null) {
        return new Response("seat reserved for bot", { status: 403 });
      }
      this.botSeats = this.botSeats.filter((s) => s !== seat);
      const existing = this.seats[seat];
      if (existing) {
        // Rename the seat from the bot's display name to a generic guest
        // label. Token stays the same so reconnects with the same URL
        // continue to land on this seat.
        this.seats[seat] = { name: "Guest", token: existing.token };
      }
      if (seat < this.botDifficulties.length) this.botDifficulties[seat] = null;
      this.alarms.cancel("bot-think");
      this.botFanOut.delete(seat);
      this.broadcastRoomState();
    }

    if (this.clientForSeat(seat) !== undefined) {
      return new Response("seat already attached", { status: 409 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({ seat } satisfies WsAttachment);
    this.ctx.acceptWebSocket(server);
    // Hand over the freshly-minted per-seat token if we just claimed via
    // the invite. Sent before any state broadcast so the client sees
    // SessionAssigned first and persists the token immediately, reducing
    // the window where a refresh would re-claim the invite and steal a
    // different seat.
    if (issuedToken !== null) {
      this.send(server, { type: "SessionAssigned", seat, token: issuedToken });
    }
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
      !this.lobbyHold &&
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
      case "StartGame": {
        const result = this.releaseLobbyHold(seat);
        if (!result.ok) {
          this.send(ws, { type: "Error", code: result.reason, message: result.reason });
        }
        await this.persist();
        return;
      }
      case "SetBotDifficulty": {
        const result = this.handleSetBotDifficulty(seat, msg.seat, msg.difficulty);
        if (!result.ok) {
          this.send(ws, { type: "Error", code: result.reason, message: result.reason });
        }
        await this.persist();
        return;
      }
      case "LobbySettingsChange": {
        const result = this.handleLobbySettingsChange(seat, msg);
        if (!result.ok) {
          this.send(ws, { type: "Error", code: result.reason, message: result.reason });
        } else {
          await this.persist();
        }
        return;
      }
    }
  }

  // Host-only. Mutates lobby settings (player count, bot count, rounds,
  // bot difficulty) on a held lobby without recreating the room. Joined
  // humans stay attached. Shrinking `playerCount` clamps at the floor of
  // `1 + currently-joined humans` — a smaller value would evict someone,
  // and there's no kick affordance yet.
  private handleLobbySettingsChange(
    sender: SeatIndex,
    change: {
      playerCount?: number;
      botCount?: number;
      rounds?: number;
      difficulty?: BotDifficulty;
    },
  ): { ok: true } | { ok: false; reason: "FORBIDDEN_ACTION" } {
    if (sender !== 0) return { ok: false, reason: "FORBIDDEN_ACTION" };
    if (this.engineState !== null) return { ok: false, reason: "FORBIDDEN_ACTION" };
    if (!this.lobbyHold) return { ok: false, reason: "FORBIDDEN_ACTION" };

    const humanSeats: SeatIndex[] = [];
    for (let i = 0; i < this.seats.length; i++) {
      if (this.seats[i] !== null && !this.botSeats.includes(i as SeatIndex)) {
        humanSeats.push(i as SeatIndex);
      }
    }
    const humanCount = humanSeats.length;

    const nextPlayerCount = change.playerCount ?? this.playerCount;
    if (!Number.isInteger(nextPlayerCount) || nextPlayerCount < 2 || nextPlayerCount > 6) {
      return { ok: false, reason: "FORBIDDEN_ACTION" };
    }
    // Clamp shrink at the human floor (host always counted in humans).
    if (nextPlayerCount < humanCount) {
      return { ok: false, reason: "FORBIDDEN_ACTION" };
    }

    let nextBotCount = change.botCount ?? this.botSeats.length;
    if (!Number.isInteger(nextBotCount) || nextBotCount < 0) {
      return { ok: false, reason: "FORBIDDEN_ACTION" };
    }
    // Bots fill what humans don't: cap to the room's spare capacity.
    const maxBots = nextPlayerCount - humanCount;
    if (nextBotCount > maxBots) nextBotCount = maxBots;
    if (nextBotCount < 0) nextBotCount = 0;

    const nextRounds = change.rounds ?? this.totalRounds;
    if (!Number.isInteger(nextRounds) || nextRounds < 1 || nextRounds > 9) {
      return { ok: false, reason: "FORBIDDEN_ACTION" };
    }
    const nextDifficulty = change.difficulty ?? this.botDifficulty;

    // Apply: rebuild the seats array around the surviving humans. Humans
    // stay where they sit (seat index preserved); empty front/middle slots
    // become null; bots refill from the back to nextBotCount.
    const oldSeats = this.seats.slice();
    const oldBotDifficulties = this.botDifficulties.slice();
    const newSeats: (Seat | null)[] = new Array<Seat | null>(nextPlayerCount).fill(null);
    const newBotDifficulties: (BotDifficulty | null)[] = new Array<BotDifficulty | null>(
      nextPlayerCount,
    ).fill(null);

    // Carry over human seats. They keep their original seat index unless
    // it now lies outside the new playerCount range — in which case we
    // already rejected via the humanCount floor above (a human on seat 4
    // implies playerCount >= 5).
    for (const h of humanSeats) {
      if (h >= nextPlayerCount) {
        // Defensive: already guarded above. Reject rather than silently drop.
        return { ok: false, reason: "FORBIDDEN_ACTION" };
      }
      newSeats[h] = oldSeats[h] ?? null;
    }

    // Bots fill from the back, skipping seats already occupied by humans.
    const newBotSeats: SeatIndex[] = [];
    const names = pickBotNames(nextBotCount);
    let placed = 0;
    for (let i = nextPlayerCount - 1; i >= 0 && placed < nextBotCount; i--) {
      if (newSeats[i] !== null) continue;
      const seatIndex = i as SeatIndex;
      newBotSeats.push(seatIndex);
      newSeats[seatIndex] = {
        name: names[placed] ?? `Bot ${nextBotCount - placed}`,
        token: randomBase64Url(TOKEN_BYTES),
      };
      newBotDifficulties[seatIndex] = nextDifficulty;
      placed += 1;
    }
    newBotSeats.sort((a, b) => a - b);

    // Any remaining empty slots stay null — the host can shrink/grow and
    // those slots will be filled either by future invitees or by bots
    // when the host releases the lobby (StartGame).

    this.playerCount = nextPlayerCount;
    this.seats = newSeats;
    this.botSeats = newBotSeats;
    this.botDifficulties = newBotDifficulties;
    this.botDifficulty = nextDifficulty;
    this.totalRounds = nextRounds;
    this.scores = new Array<number>(nextPlayerCount).fill(0);
    this.rematchSeats = new Array<boolean>(nextPlayerCount).fill(false);
    void oldBotDifficulties; // kept for future migration if shapes change

    this.broadcastRoomState();
    return { ok: true };
  }

  // Host-only mutation. Only valid before the engine starts (lobby
  // phase). Updates the per-seat difficulty for a bot seat and rebroadcasts
  // RoomState so every connected peer re-renders the lobby roster.
  private handleSetBotDifficulty(
    sender: SeatIndex,
    targetSeat: number,
    difficulty: BotDifficulty,
  ): { ok: true } | { ok: false; reason: "FORBIDDEN_ACTION" } {
    if (sender !== 0) return { ok: false, reason: "FORBIDDEN_ACTION" };
    if (this.engineState !== null) return { ok: false, reason: "FORBIDDEN_ACTION" };
    if (!this.botSeats.includes(targetSeat as SeatIndex)) {
      return { ok: false, reason: "FORBIDDEN_ACTION" };
    }
    if (targetSeat < 0 || targetSeat >= this.botDifficulties.length) {
      return { ok: false, reason: "FORBIDDEN_ACTION" };
    }
    this.botDifficulties[targetSeat] = difficulty;
    this.broadcastRoomState();
    return { ok: true };
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

  testSetCloseWindowMs(ms: number): void {
    this.closeWindowMs = ms;
  }

  testCloseWindowMs(): number {
    return this.closeWindowMs;
  }

  testPendingClose(): PendingCloseState | null {
    return this.pendingClose
      ? { ...this.pendingClose, passed: [...this.pendingClose.passed] }
      : null;
  }

  testBotFanOut(): { seat: SeatIndex; at: number }[] {
    return Array.from(this.botFanOut.entries()).map(([seat, at]) => ({ seat, at }));
  }

  // Test seam: snapshot the match state the way `broadcastRoomState`
  // builds it. Returns null for legacy single-round rooms so tests can
  // assert on the multi-round case explicitly.
  testMatchState(): {
    currentRound: number;
    totalRounds: number;
    scores: number[];
    matchOver: boolean;
  } | null {
    if (this.totalRounds <= 1) return null;
    return {
      currentRound: this.currentRound,
      totalRounds: this.totalRounds,
      scores: this.scores.slice(),
      matchOver: this.matchOver,
    };
  }

  // Test seam: synthesize a game-over with a designated durak so the
  // match-flow tests can drive round transitions without playing real
  // hands. Mirrors what the engine produces on natural game-over.
  testForceGameOver(durak: SeatIndex): void {
    this.engineState = {
      phase: "game-over",
      durak,
      playerCount: this.playerCount,
    } as State;
    this.bumpStaleIfFinished();
    this.broadcastRoomState();
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
      } else if (kind === "close-window") {
        this.fireCloseWindow();
        mutated = true;
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
    // Kick any still-attached WSes with a recognisable close code so the
    // client can route the user back to the menu. Without this the WS
    // stays open against an empty DO and every action returns
    // GAME_NOT_STARTED — the silent-zombie symptom.
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(CLOSE_CODE_ROOM_EXPIRED, `room expired (${reason})`);
      } catch {
        // already closing — ignore
      }
    }
    this.engineState = null;
    this.seats = new Array<Seat | null>(this.playerCount).fill(null);
    this.botSeats = [];
    this.rematchSeats = new Array<boolean>(this.playerCount).fill(false);
    this.disconnects = [];
    this.pendingClose = null;
    this.pendingCloseBy = null;
    this.botFanOut.clear();
    this.pendingThrowIn = null;
    this.inviteToken = null;
    // Clear all alarm bookkeeping before deleteAll wipes the persisted map.
    this.alarms.cancel("turn-timeout");
    this.alarms.cancel("forfeit");
    this.alarms.cancel("abandoned");
    this.alarms.cancel("idle");
    this.alarms.cancel("stale");
    this.alarms.cancel("bot-think");
    this.alarms.cancel("close-window");
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
      this.alarms.cancel("close-window");
      this.disconnects = [];
      this.pendingClose = null;
      this.pendingCloseBy = null;
      this.botFanOut.clear();
      this.botChainCount = 0;
      const wasScored = this.currentRoundScored;
      this.recordRoundResult();
      if (!wasScored && this.currentRoundScored) {
        // Scores just updated — push fresh RoomState so the game-over
        // screen receives the correct match standings immediately.
        this.broadcastRoomState();
      }
      if (!this.alarms.has("stale")) {
        this.alarms.schedule("stale", Date.now() + STALE_MS);
      }
    } else {
      this.alarms.cancel("stale");
    }
  }

  // Record round scores and check if the match is over. Idempotent —
  // guarded by `currentRoundScored` so repeated calls (every action
  // while in game-over re-runs `bumpStaleIfFinished`) don't double-count.
  // No-op for single-round rooms (`totalRounds === 1`).
  //
  // Scoring: position-based. Winner (first PLAYER_OUT) = 0 pts. Each
  // subsequent elimination = 1 more pt. Durak (last remaining) always
  // gets `playerCount` pts — an extra point vs the second-to-last
  // finisher to penalise being the durak vs just surviving longest.
  // Example, 4 players: winner=0, 2nd=1, 3rd=2, durak=4.
  private recordRoundResult(): void {
    if (this.totalRounds <= 1) return;
    if (this.currentRoundScored) return;
    if (this.engineState === null || this.engineState.phase !== "game-over") return;
    const durak = this.engineState.durak;
    for (let seat = 0; seat < this.playerCount; seat++) {
      if (seat === durak) {
        this.scores[seat] = (this.scores[seat] ?? 0) + this.playerCount;
      } else {
        const pos = this.finishOrder.indexOf(seat as SeatIndex);
        // pos === -1 means the seat was still in play when the game ended
        // abnormally (forfeit). Treat them as finishing just before the durak.
        const pts = pos >= 0 ? pos : this.finishOrder.length;
        this.scores[seat] = (this.scores[seat] ?? 0) + pts;
      }
    }
    this.currentRoundScored = true;
    if (this.currentRound >= this.totalRounds) {
      this.matchOver = true;
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
    this.trackEliminations(result.events);
    this.bumpStaleIfFinished();
    this.broadcast(result.events);
    this.scheduleTurnTimer();
    this.armBotTurnIfNeeded();
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
    this.pendingClose = null;
    this.pendingCloseBy = null;
    this.botFanOut.clear();
    this.pendingThrowIn = null;
    this.alarms.cancel("turn-timeout");
    this.alarms.cancel("bot-think");
    this.alarms.cancel("forfeit");
    this.alarms.cancel("close-window");
    this.botChainCount = 0;
    const forfeitEvents: Event[] = [{ type: "GAME_OVER", durak: seat }];
    this.trackEliminations(forfeitEvents);
    this.bumpStaleIfFinished();
    this.broadcastRoomState();
    this.broadcast(forfeitEvents);
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

  // Pick the next seat a fresh invite-token claim should land on. Bot
  // seats first (matches the host's "filling with bots, friends drop in"
  // mental model), then any genuinely empty seat as a fallback.
  private firstClaimableSeat(): SeatIndex | null {
    for (let i = 0; i < this.seats.length; i++) {
      if (this.botSeats.includes(i as SeatIndex)) return i as SeatIndex;
    }
    for (let i = 0; i < this.seats.length; i++) {
      if (this.seats[i] === null) return i as SeatIndex;
    }
    return null;
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
    this.finishOrder = [];
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

  // Host (seat 0) presses "start". Two responsibilities:
  //   1. Releases the FFA lobby hold and starts round 1, OR
  //   2. Advances to the next round in a multi-round match after a
  //      game-over (totalRounds > 1, !matchOver).
  // Either path is host-only and rejects if the precondition isn't met.
  private releaseLobbyHold(
    seat: SeatIndex,
  ): { ok: true } | { ok: false; reason: "FORBIDDEN_ACTION" } {
    if (seat !== 0) return { ok: false, reason: "FORBIDDEN_ACTION" };
    // Path 1: lobby hold release (round 1 of a fresh room).
    if (this.lobbyHold) {
      if (this.engineState !== null) return { ok: false, reason: "FORBIDDEN_ACTION" };
      this.lobbyHold = false;
      this.broadcastRoomState();
      if (this.allSeatsFilled() && this.attachedSeatCount() === this.playerCount) {
        this.startGame(newSeed());
      }
      return { ok: true };
    }
    // Path 2: advance to the next round of a multi-round match.
    if (
      this.totalRounds > 1 &&
      !this.matchOver &&
      this.engineState !== null &&
      this.engineState.phase === "game-over"
    ) {
      this.advanceToNextRound();
      return { ok: true };
    }
    return { ok: false, reason: "FORBIDDEN_ACTION" };
  }

  // Advance the match to the next round: bump `currentRound`, clear the
  // engine, and start a fresh game with the same seats. Called from
  // `StartGame` (host's "next round" press) after a game-over scored.
  private advanceToNextRound(): void {
    this.cancelTurnTimer();
    this.alarms.cancel("stale");
    this.alarms.cancel("bot-think");
    this.alarms.cancel("close-window");
    this.botChainCount = 0;
    this.pendingClose = null;
    this.pendingCloseBy = null;
    this.botFanOut.clear();
    this.pendingThrowIn = null;
    this.engineState = null;
    this.rematchSeats = new Array<boolean>(this.playerCount).fill(false);
    this.currentRound += 1;
    this.currentRoundScored = false;
    this.broadcastRoomState();
    this.startGame(newSeed());
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
    this.alarms.cancel("close-window");
    this.botChainCount = 0;
    this.pendingClose = null;
    this.pendingCloseBy = null;
    this.botFanOut.clear();
    this.pendingThrowIn = null;
    this.engineState = null;
    this.rematchSeats = new Array<boolean>(this.playerCount).fill(false);
    // Rematch always restarts the entire match — zero scores, back to
    // round 1, matchOver cleared. Single-round rooms keep `totalRounds`
    // as 1 so this is a no-op for legacy flow.
    this.currentRound = 1;
    this.scores = new Array<number>(this.playerCount).fill(0);
    this.matchOver = false;
    this.currentRoundScored = false;
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
    return this.applyEnforcedAction(enforced);
  }

  // Shared apply path: human submissions arrive here through `applyAction`
  // (with the auth/`by` overrides), bot decisions arrive here directly via
  // `runBotMoveNow` / fan-out alarm. Encapsulates the pending-close window
  // state machine so both paths agree on legality and side effects.
  private applyEnforcedAction(enforced: Action): ApplyResult {
    if (this.engineState === null) return { ok: false, reason: "GAME_NOT_STARTED" };
    if (this.engineState.phase !== "in-round") {
      const result = step(this.engineState, enforced);
      if (!result.ok) return { ok: false, reason: result.reason };
      this.engineState = result.state;
      this.cancelTurnTimer();
      this.trackEliminations(result.events);
      this.bumpStaleIfFinished();
      this.broadcast(result.events);
      this.armBotTurnIfNeeded();
      this.scheduleTurnTimer();
      return { ok: true, state: this.engineState, events: result.events };
    }

    if (this.pendingClose !== null) {
      // During the throw-in window only THROW_IN and PASS are accepted —
      // everything else (including a duplicate END_ROUND / TAKE_PILE) is
      // rejected so the pending action's parameters are stable until close.
      if (enforced.type === "PASS") return this.handlePassDuringWindow(enforced);
      if (enforced.type === "THROW_IN") return this.handleThrowInDuringWindow(enforced);
      return { ok: false, reason: "FORBIDDEN_ACTION" };
    }

    if (enforced.type === "PASS") {
      // PASS outside the window has no addressee — there is no decision
      // pending that a pass would defer.
      return { ok: false, reason: "FORBIDDEN_ACTION" };
    }

    // Round-resolving actions open the pending-close window when the
    // engine accepts them. Anything else applies immediately.
    if (
      (enforced.type === "END_ROUND" || enforced.type === "TAKE_PILE") &&
      this.shouldOpenCloseWindow()
    ) {
      const probe = step(this.engineState, enforced);
      if (!probe.ok) return { ok: false, reason: probe.reason };
      this.openCloseWindow(enforced);
      return { ok: true, state: this.engineState, events: [] };
    }

    return this.applyToEngine(enforced);
  }

  private applyToEngine(enforced: Action): ApplyResult {
    if (this.engineState === null) return { ok: false, reason: "GAME_NOT_STARTED" };
    const result = step(this.engineState, enforced);
    if (!result.ok) return { ok: false, reason: result.reason };
    this.engineState = result.state;
    this.cancelTurnTimer();
    this.trackEliminations(result.events);
    this.advancePastEliminatedActor();
    // Run scoring before fanning out events: when this action triggers
    // GAME_OVER, clients receive the updated RoomState (scores, matchOver)
    // first, so the GameOverScreen builds with correct match standings
    // instead of stale zeros.
    this.bumpStaleIfFinished();
    this.broadcast(result.events);
    // Bot-turn announcement and turn timer come after the events so the
    // `thinkingSeats` RoomState lands once clients have applied the move
    // that produced the new active seat.
    this.armBotTurnIfNeeded();
    this.scheduleTurnTimer();
    // After a successful defend that drains the defender to 0 cards with
    // every attack on the table beaten, no further legal action remains
    // (DEFENDER_OVERWHELMED blocks ATTACK and THROW_IN, defender can't
    // ATTACK). Bots auto-fire END_ROUND in that state; humans don't, so
    // the round sits stuck until the turn timer expires. Auto-fire on
    // the attacker's behalf so play continues without a 30s wait.
    if (enforced.type !== "END_ROUND") this.maybeAutoEndRound();
    return { ok: true, state: this.engineState, events: result.events };
  }

  private maybeAutoEndRound(): void {
    if (this.engineState === null || this.engineState.phase !== "in-round") return;
    if (this.pendingClose !== null) return;
    if (this.engineState.table.length === 0) return;
    if (this.engineState.table.some((p) => !p.defense)) return;
    const defenderHand = this.engineState.hands[this.engineState.defender];
    if (!defenderHand || defenderHand.length > 0) return;
    // Skip the close-window: throw-ins are blocked anyway (defender at 0),
    // so opening the window would just add latency for no decision.
    this.applyToEngine({ type: "END_ROUND", by: this.engineState.attacker });
  }

  private handlePassDuringWindow(action: Extract<Action, { type: "PASS" }>): ApplyResult {
    if (this.engineState === null || this.pendingClose === null) {
      return { ok: false, reason: "FORBIDDEN_ACTION" };
    }
    const result = step(this.engineState, action);
    if (!result.ok) return { ok: false, reason: result.reason };
    if (!this.pendingClose.passed.includes(action.by)) {
      this.pendingClose = {
        ...this.pendingClose,
        passed: [...this.pendingClose.passed, action.by].sort((a, b) => a - b),
      };
    }
    this.botFanOut.delete(action.by);
    this.broadcast(result.events);
    if (this.allActiveNonDefendersPassed()) {
      // Everyone has explicitly opted out — fire the close immediately
      // rather than waiting for the alarm.
      this.alarms.cancel("close-window");
      this.fireCloseWindow();
      return { ok: true, state: this.engineState, events: result.events };
    }
    this.refreshBotFanOutAlarm();
    this.broadcastRoomState();
    return { ok: true, state: this.engineState, events: result.events };
  }

  private handleThrowInDuringWindow(action: Extract<Action, { type: "THROW_IN" }>): ApplyResult {
    if (this.engineState === null || this.pendingClose === null) {
      return { ok: false, reason: "FORBIDDEN_ACTION" };
    }
    const result = step(this.engineState, action);
    if (!result.ok) return { ok: false, reason: result.reason };
    this.engineState = result.state;
    // Reset the window: every non-defender gets fresh consideration after
    // a pile-on. Cancel both bot fan-out and the close alarm; we re-arm.
    this.pendingClose = {
      ...this.pendingClose,
      closesAt: Date.now() + this.closeWindowMs,
      passed: [],
    };
    this.botFanOut.clear();
    this.cancelTurnTimer();
    this.broadcast(result.events);
    this.alarms.schedule("close-window", this.pendingClose.closesAt);
    this.scheduleBotFanOut();
    this.broadcastRoomState();
    return { ok: true, state: this.engineState, events: result.events };
  }

  // The window is meaningless at N=2 — the only non-defender is the
  // attacker, and the attacker had unlimited time to throw in before
  // submitting the round-resolver. Skip it for back-compat with the
  // existing 1v1 flows. Also skip when the pacing override sets
  // `closeWindowMs` to 0 (test seam).
  private shouldOpenCloseWindow(): boolean {
    if (this.engineState === null || this.engineState.phase !== "in-round") return false;
    if (this.playerCount <= 2) return false;
    if (this.closeWindowMs <= 0) return false;
    // Once enough players have been eliminated that only the defender + one
    // attacker remain, the throw-in window has nobody to wait on — skip it
    // and finalise the round immediately.
    const eliminated = eliminatedSeatsOfState(this.engineState);
    if (this.playerCount - eliminated.size <= 2) return false;
    return true;
  }

  private openCloseWindow(action: Extract<Action, { type: "END_ROUND" | "TAKE_PILE" }>): void {
    const closesAt = Date.now() + this.closeWindowMs;
    this.pendingClose = { kind: action.type, closesAt, passed: [] };
    this.pendingCloseBy = action.by;
    this.botFanOut.clear();
    this.cancelTurnTimer();
    this.alarms.cancel("bot-think");
    this.alarms.schedule("close-window", closesAt);
    this.scheduleBotFanOut();
    this.broadcastRoomState();
  }

  private fireCloseWindow(): void {
    if (this.engineState === null || this.pendingClose === null) {
      this.pendingClose = null;
      this.pendingCloseBy = null;
      this.botFanOut.clear();
      return;
    }
    const kind = this.pendingClose.kind;
    const closeBy = this.pendingCloseBy ?? 0;
    this.pendingClose = null;
    this.pendingCloseBy = null;
    this.botFanOut.clear();
    this.pendingThrowIn = null;
    this.alarms.cancel("close-window");

    // If the original action was END_ROUND but throw-ins added undefended
    // attacks during the window, applying END_ROUND now would be rejected
    // by the engine (ATTACKS_UNDEFENDED in step.ts), the state would not
    // advance, and the defender bot would never be scheduled — game stuck.
    // The window's purpose is moot: the round didn't end, the defender
    // simply has new cards to face. Skip the apply and wake the active
    // actor (the defender) so play continues.
    //
    // TAKE_PILE never has this problem: the engine accepts it regardless
    // of new throw-ins (defender just picks up everything), so we let it
    // flow through applyToEngine unchanged.
    if (
      kind === "END_ROUND" &&
      this.engineState.phase === "in-round" &&
      this.engineState.table.some((p) => !p.defense)
    ) {
      this.cancelTurnTimer();
      this.advancePastEliminatedActor();
      this.armBotTurnIfNeeded();
      this.scheduleTurnTimer();
      this.broadcastRoomState();
      return;
    }

    this.applyToEngine({ type: kind, by: closeBy });
    // Clear pendingClose from broadcast view in case applyToEngine returns
    // mid-game (still in-round): RoomState was already broadcast inside
    // applyToEngine via armBotTurnIfNeeded paths, but we want a fresh one
    // with `pendingClose: null` so the client retracts the banner.
    this.broadcastRoomState();
  }

  private allActiveNonDefendersPassed(): boolean {
    if (this.engineState === null || this.engineState.phase !== "in-round") return true;
    if (this.pendingClose === null) return true;
    const eliminated = eliminatedSeatsOfState(this.engineState);
    const passed = new Set(this.pendingClose.passed);
    for (let s = 0; s < this.playerCount; s++) {
      if (s === this.engineState.defender) continue;
      if (eliminated.has(s)) continue;
      if (!passed.has(s)) return false;
    }
    return true;
  }

  // Schedules bot fan-out: every non-defender non-eliminated bot seat that
  // hasn't already passed gets a per-seat deadline. Their actual decision
  // (THROW_IN matching card if any, else PASS) runs when the shared
  // bot-think alarm fires.
  private scheduleBotFanOut(): void {
    if (this.engineState === null || this.engineState.phase !== "in-round") return;
    if (this.pendingClose === null) return;
    const eliminated = eliminatedSeatsOfState(this.engineState);
    const passed = new Set(this.pendingClose.passed);
    const now = Date.now();
    for (const seat of this.botSeats) {
      if (seat === this.engineState.defender) continue;
      if (eliminated.has(seat)) continue;
      if (passed.has(seat)) continue;
      if (this.botFanOut.has(seat)) continue;
      const baseDelay = computeThinkDelay({
        state: this.engineState,
        seat,
        difficulty: this.difficultyFor(seat),
        bounds: this.thinkBounds,
      });
      const delay = baseDelay <= 0 ? 0 : baseDelay;
      this.botFanOut.set(seat, now + delay);
    }
    this.refreshBotFanOutAlarm();
  }

  // Per-seat difficulty lookup with a single-source-of-truth fallback.
  // Reads from `botDifficulties[seat]`; if that entry is missing (e.g.
  // legacy persisted state mid-migration), falls back to the global
  // `botDifficulty`. Always returns a non-null BotDifficulty.
  private difficultyFor(seat: SeatIndex): BotDifficulty {
    return this.botDifficulties[seat] ?? this.botDifficulty;
  }

  // Earliest of the pending fan-out deadlines decides when bot-think fires.
  // The alarm dispatcher drains every entry whose deadline elapsed.
  private refreshBotFanOutAlarm(): void {
    if (this.botFanOut.size === 0) {
      // Don't cancel bot-think here unconditionally — the regular pacing
      // path (non-window) also uses it. Only cancel if there's no pending
      // window-driven fan-out *and* the regular path doesn't want it.
      if (this.pendingClose !== null) this.alarms.cancel("bot-think");
      return;
    }
    let earliest = Number.POSITIVE_INFINITY;
    for (const at of this.botFanOut.values()) {
      if (at < earliest) earliest = at;
    }
    this.alarms.schedule("bot-think", earliest);
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
      this.trackEliminations(result.events);
      // If a chained TIMEOUT eliminated the last surviving non-durak,
      // record scores + broadcast RoomState BEFORE fanning out the events
      // so clients receive updated match.scores before the GAME_OVER event.
      if (this.engineState.phase !== "in-round") {
        this.bumpStaleIfFinished();
      }
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
    this.pendingThrowIn = null;
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
    if (this.pendingClose !== null) {
      // The fan-out scheduler owns bot-think while the close window is open.
      // The active actor is a bystander — it's the pre-resolution defender
      // for END_ROUND or the pre-pile attacker for TAKE_PILE — and the
      // single-bot pacing path would mis-fire if it tried to act here.
      return;
    }

    // Mid-round throw-in (FFA): when the table is fully defended, any
    // non-defender — not just the attacker — may pile on with a matching-
    // rank card. The existing flow only schedules the active actor (the
    // attacker, after a defense), so without this only the attacker bot
    // ever throws in mid-round. Find an eligible non-attacker bot first
    // and schedule them ahead of the attacker's normal turn.
    const throwIn = this.findMidRoundThrowIn(this.engineState);
    const actingSeat = throwIn?.seat ?? activeActorSeat(this.engineState);
    if (throwIn !== null) {
      this.pendingThrowIn = throwIn;
    } else if (!this.botSeats.includes(actingSeat)) {
      this.botChainCount = 0;
      this.clearThinkingState();
      return;
    }
    if (this.botChainCount >= this.botIterationCap) {
      this.botChainCount = 0;
      this.pendingThrowIn = null;
      this.clearThinkingState();
      this.sendErrorToHumans("BOT_LOOP_CAP", "bot iteration cap reached");
      return;
    }
    this.botChainCount += 1;
    const baseDelay = computeThinkDelay({
      state: this.engineState,
      seat: actingSeat,
      difficulty: this.difficultyFor(actingSeat),
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

  // Returns a queued throw-in for a non-attacker non-defender bot when
  // one is eligible: the table must be fully defended (no undefended
  // attacks), under the per-bout cap (6), the defender must still have
  // enough cards to face another beat, and the seat must hold a card
  // whose rank already appears on the table. Picks the cheapest matching
  // card (non-trumps first, lowest rank first) to mirror the engine bot's
  // own throw-in heuristic. Returns the lowest seat index when several
  // bots are eligible — order doesn't matter much for FFA, and stable
  // ordering keeps replay traces predictable.
  private findMidRoundThrowIn(state: InRoundState): { seat: SeatIndex; card: Card } | null {
    if (state.table.length === 0) return null;
    if (state.table.length >= 6) return null;
    if (state.table.some((p) => !p.defense)) return null;
    const defenderHand = state.hands[state.defender];
    if (!defenderHand || defenderHand.length === 0) return null;
    const ranks = new Set<number>();
    for (const pair of state.table) {
      ranks.add(pair.attack.rank);
      if (pair.defense) ranks.add(pair.defense.rank);
    }
    const eliminated = eliminatedSeatsOfState(state);
    const trump = state.trumpSuit;
    for (const seat of [...this.botSeats].sort((a, b) => a - b)) {
      if (seat === state.defender) continue;
      if (seat === state.attacker) continue;
      if (eliminated.has(seat)) continue;
      const hand = state.hands[seat];
      if (!hand || hand.length === 0) continue;
      const matches = hand.filter((c) => ranks.has(c.rank));
      if (matches.length === 0) continue;
      const sorted = [...matches].sort((a, b) => {
        const trumpA = a.suit === trump ? 1 : 0;
        const trumpB = b.suit === trump ? 1 : 0;
        if (trumpA !== trumpB) return trumpA - trumpB;
        return a.rank - b.rank;
      });
      const card = sorted[0];
      if (card) return { seat, card };
    }
    return null;
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
    if (this.pendingClose !== null) {
      this.runBotFanOut();
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
    // Surface the new turn-timeout deadline when the next actor is a
    // human (i.e. armBotTurnIfNeeded didn't schedule a fresh bot-think
    // and didn't broadcast). Without this the player has no visible
    // countdown after the bot finishes its move.
    if (!this.alarms.has("bot-think")) this.broadcastRoomState();
    return true;
  }

  // Drains every pending fan-out seat. The single AlarmScheduler slot
  // can't carry per-seat deadlines, so when bot-think fires during the
  // window we treat every queued bot as ready — staggering is a UX nicety
  // that didn't survive the single-slot constraint. The first THROW_IN
  // extends the window (and resets fan-out for everyone); remaining
  // unprocessed seats fall out for re-scheduling on the next pass.
  private runBotFanOut(): void {
    if (this.engineState === null || this.engineState.phase !== "in-round") return;
    if (this.pendingClose === null) return;
    const due = Array.from(this.botFanOut.keys()).sort((a, b) => a - b);
    for (const seat of due) {
      if (this.engineState === null || this.engineState.phase !== "in-round") break;
      if (this.pendingClose === null) break;
      this.botFanOut.delete(seat);
      const action = chooseFanOutAction(this.engineState, seat);
      this.applyEnforcedAction(action);
    }
    if (this.pendingClose !== null) {
      this.refreshBotFanOutAlarm();
    }
  }

  // Synchronously runs one bot.choose -> apply. Returns true if a move
  // landed. Used by the alarm handler and by the zero-delay fast path.
  // Routes through `applyEnforcedAction` so bot END_ROUND / TAKE_PILE
  // opens the FFA throw-in close window (ADR-0011) the same way a human
  // submission does — without this, bots would resolve rounds instantly
  // in 3+ player FFA and leave nobody a chance to throw in.
  private runBotMoveNow(): boolean {
    if (this.botSeats.length === 0) return false;
    if (this.engineState === null || this.engineState.phase !== "in-round") return false;
    // Mid-round throw-in: a non-active non-defender bot was queued by
    // `armBotTurnIfNeeded` to pile on. Submit ahead of the active actor's
    // normal `bot.choose` so non-attacker bots actually throw in during
    // the bout instead of waiting for the close window.
    const pending = this.pendingThrowIn;
    this.pendingThrowIn = null;
    if (pending !== null && this.botSeats.includes(pending.seat)) {
      const action: Action = { type: "THROW_IN", by: pending.seat, card: pending.card };
      const result = this.applyEnforcedAction(action);
      if (result.ok) return true;
      // Engine rejected (e.g. state advanced between scheduling and firing).
      // Fall through to the active actor's normal move so the round still
      // makes progress.
    }
    const active = activeActorSeat(this.engineState);
    if (!this.botSeats.includes(active)) return false;
    const action = bot.choose(this.engineState, { difficulty: this.difficultyFor(active) });
    const result = this.applyEnforcedAction(action);
    if (!result.ok) {
      this.sendErrorToHumans("BOT_ILLEGAL_ACTION", `bot rejected: ${result.reason}`);
      return false;
    }
    return true;
  }

  // ─── broadcasting ──────────────────────────────────────────────────────

  // Track finish order for position-based scoring. PLAYER_OUT events
  // arrive in elimination order, so appending here is sufficient. Called
  // by action paths BEFORE bumpStaleIfFinished so score recording sees the
  // updated finishOrder when the durak's last move ends the game.
  private trackEliminations(events: Event[]): void {
    for (const e of events) {
      if (e.type === "PLAYER_OUT" && !this.finishOrder.includes(e.seat as SeatIndex)) {
        this.finishOrder.push(e.seat as SeatIndex);
      }
    }
  }

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
    const botSeatSet = new Set<SeatIndex>(this.botSeats);
    const seats: RoomSeat[] = this.seats.map((s, idx) => {
      const isBot = botSeatSet.has(idx as SeatIndex);
      const out: RoomSeat = {
        name: s ? s.name : null,
        kind: isBot ? "bot" : "human",
      };
      if (isBot) {
        out.difficulty = this.difficultyFor(idx as SeatIndex);
      }
      return out;
    });
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
    const pendingClose: PendingCloseState | null = this.pendingClose
      ? { ...this.pendingClose, passed: [...this.pendingClose.passed] }
      : null;
    // Surface the per-turn timeout deadline so clients can render a
    // countdown for whoever is on the move. Suppressed during the
    // close window — the close-window banner already owns the visible
    // timer in that state.
    const turnDeadline = pendingClose === null ? (this.alarms.get("turn-timeout") ?? null) : null;
    // Match block — only attached when this is a multi-round room. Single-
    // round rooms (totalRounds === 1) keep the legacy field shape.
    const match: MatchState | null =
      this.totalRounds > 1
        ? {
            currentRound: this.currentRound,
            totalRounds: this.totalRounds,
            scores: this.scores.slice(),
            matchOver: this.matchOver,
          }
        : null;
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
        pendingClose,
        turnDeadline,
        match,
      };
      this.send(ws, msg);
    }
  }

  private computeThinkingSeats(): SeatIndex[] {
    if (this.engineState === null || this.engineState.phase !== "in-round") return [];
    if (this.pendingClose !== null) {
      // During the window, every bot seat with a pending fan-out is
      // "thinking" — the client renders all of them in parallel.
      return Array.from(this.botFanOut.keys()).sort((a, b) => a - b);
    }
    if (!this.alarms.has("bot-think")) return [];
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
    // The FFA close window owns the active deadline; arming a separate
    // turn-timeout would race the close-window alarm and could synthesize
    // a TIMEOUT for the wrong actor when it fires.
    if (this.pendingClose !== null) return;
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
      pendingClose: this.pendingClose
        ? { ...this.pendingClose, passed: [...this.pendingClose.passed] }
        : null,
      pendingCloseBy: this.pendingCloseBy,
      botFanOut: Array.from(this.botFanOut.entries()).map(([seat, at]) => ({ seat, at })),
      lobbyHold: this.lobbyHold,
      totalRounds: this.totalRounds,
      currentRound: this.currentRound,
      scores: this.scores.slice(),
      matchOver: this.matchOver,
      finishOrder: this.finishOrder.slice(),
      botDifficulties: this.botDifficulties.slice(),
      inviteToken: this.inviteToken,
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

// Pick `count` distinct names from `BOT_NAMES`. Uses a Fisher-Yates
// shuffle seeded from `crypto.getRandomValues` so different rooms don't
// always seat the same names, and so within a room every bot has a
// different name. Falls back to "Bot N" if `count` exceeds the pool —
// shouldn't happen for our 2-6 player range, but better than throwing.
export function pickBotNames(count: number): string[] {
  if (count <= 0) return [];
  const pool = [...BOT_NAMES];
  const seedBuf = new Uint32Array(pool.length);
  crypto.getRandomValues(seedBuf);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = (seedBuf[i] ?? 0) % (i + 1);
    const a = pool[i];
    const b = pool[j];
    if (a !== undefined && b !== undefined) {
      pool[i] = b;
      pool[j] = a;
    }
  }
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(pool[i] ?? `Bot ${i + 1}`);
  }
  return out;
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

// Picks a fan-out reply for one bot seat during the close window. If the
// seat has at least one card whose rank is on the table, throw the
// cheapest such card; otherwise pass. Re-uses the engine's standard
// "cheapest card" ordering (non-trumps first, low rank first) so the bot
// never spends a high-rank card on a throw-in when a low one would do.
export function chooseFanOutAction(state: InRoundState, seat: SeatIndex): Action {
  const hand = state.hands[seat] ?? [];
  if (hand.length === 0) return { type: "PASS", by: seat };
  const ranks = new Set<number>();
  for (const pair of state.table) {
    ranks.add(pair.attack.rank);
    if (pair.defense) ranks.add(pair.defense.rank);
  }
  const candidates = hand.filter((c) => ranks.has(c.rank));
  if (candidates.length === 0) return { type: "PASS", by: seat };
  const trump = state.trumpSuit;
  const sorted = [...candidates].sort((a, b) => {
    const trumpA = a.suit === trump ? 1 : 0;
    const trumpB = b.suit === trump ? 1 : 0;
    if (trumpA !== trumpB) return trumpA - trumpB;
    return a.rank - b.rank;
  });
  const card = sorted[0] as Card;
  return { type: "THROW_IN", by: seat, card };
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
