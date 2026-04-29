import type {
  ErrorMessage,
  EventsMessage,
  RoomStateMessage,
  SnapshotMessage,
} from "@durak/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  backoffDelay,
  buildSocketUrl,
  type ConnectionStatus,
  connect,
  type WsClientHandlers,
  type WsSocket,
} from "./wsClient.js";

interface ScheduledTimer {
  cb: () => void;
  delayMs: number;
  cancelled: boolean;
}

class FakeSocket implements WsSocket {
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly sent: string[] = [];
  closeCalls: { code?: number; reason?: string }[] = [];

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    const call: { code?: number; reason?: string } = {};
    if (code !== undefined) call.code = code;
    if (reason !== undefined) call.reason = reason;
    this.closeCalls.push(call);
  }

  emitOpen(): void {
    this.onopen?.(undefined);
  }

  emitMessage(data: unknown): void {
    this.onmessage?.({ data });
  }

  emitClose(code = 1006, reason = ""): void {
    this.onclose?.({ code, reason });
  }
}

interface Harness {
  sockets: FakeSocket[];
  timers: ScheduledTimer[];
  factory: (url: string) => WsSocket;
  schedule: (cb: () => void, delayMs: number) => () => void;
  fireTimer(index?: number): void;
}

function makeHarness(): Harness {
  const sockets: FakeSocket[] = [];
  const timers: ScheduledTimer[] = [];
  return {
    sockets,
    timers,
    factory: (url) => {
      const sock = new FakeSocket(url);
      sockets.push(sock);
      return sock;
    },
    schedule: (cb, delayMs) => {
      const timer: ScheduledTimer = { cb, delayMs, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    fireTimer(index = timers.length - 1) {
      const timer = timers[index];
      if (!timer) throw new Error(`no timer at ${index}`);
      if (timer.cancelled) throw new Error(`timer ${index} was cancelled`);
      timer.cb();
    },
  };
}

interface RecordedHandlers extends WsClientHandlers {
  snapshots: SnapshotMessage[];
  events: EventsMessage[];
  errors: ErrorMessage[];
  roomStates: RoomStateMessage[];
  statusLog: { status: ConnectionStatus; attempts: number; error?: string }[];
}

function makeHandlers(): RecordedHandlers {
  const snapshots: SnapshotMessage[] = [];
  const events: EventsMessage[] = [];
  const errors: ErrorMessage[] = [];
  const roomStates: RoomStateMessage[] = [];
  const statusLog: { status: ConnectionStatus; attempts: number; error?: string }[] = [];
  return {
    snapshots,
    events,
    errors,
    roomStates,
    statusLog,
    onSnapshot: (msg) => snapshots.push(msg),
    onEvents: (msg) => events.push(msg),
    onError: (msg) => errors.push(msg),
    onRoomState: (msg) => roomStates.push(msg),
    onStatus: (status, info) => {
      const entry: { status: ConnectionStatus; attempts: number; error?: string } = {
        status,
        attempts: info.attempts,
      };
      if (info.error !== undefined) entry.error = info.error;
      statusLog.push(entry);
    },
  };
}

const ACE_OF_SPADES = { suit: "spades", rank: 14 } as const;

const SNAPSHOT_FRAME: SnapshotMessage = {
  type: "Snapshot",
  snapshot: {
    phase: "in-round",
    playerCount: 2,
    handCounts: [6, 6],
    talonCount: 23,
    trump: ACE_OF_SPADES,
    trumpSuit: "spades",
    table: [],
    attacker: 0,
    defender: 1,
    discard: [],
    seat: 0,
    you: { seat: 0, hand: [ACE_OF_SPADES] },
  },
};

const ERROR_FRAME: ErrorMessage = {
  type: "Error",
  code: "BAD_ACTION",
  message: "no",
};

describe("buildSocketUrl", () => {
  it("encodes roomId and token as query params", () => {
    expect(buildSocketUrl("ws://host/ws", "ABCD", "tok")).toBe(
      "ws://host/ws?roomId=ABCD&token=tok",
    );
  });

  it("omits the token when empty", () => {
    expect(buildSocketUrl("ws://host/ws", "ABCD", "")).toBe("ws://host/ws?roomId=ABCD");
  });
});

describe("backoffDelay", () => {
  it("ramps up and caps at 5s", () => {
    expect(backoffDelay(1)).toBe(100);
    expect(backoffDelay(2)).toBe(200);
    expect(backoffDelay(3)).toBe(400);
    expect(backoffDelay(4)).toBe(800);
    expect(backoffDelay(5)).toBe(1600);
    expect(backoffDelay(6)).toBe(3200);
    expect(backoffDelay(7)).toBe(5000);
    expect(backoffDelay(20)).toBe(5000);
  });
});

describe("connect", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
  });

  function start(handlers: WsClientHandlers, harness = makeHarness()) {
    const conn = connect({
      roomId: "ABCD",
      token: "tok",
      serverUrl: "ws://host/ws",
      handlers,
      socketFactory: harness.factory,
      schedule: harness.schedule,
    });
    return { conn, harness };
  }

  it("transitions connecting -> open and dispatches inbound frames", () => {
    const handlers = makeHandlers();
    const { harness } = start(handlers);
    expect(harness.sockets).toHaveLength(1);
    expect(handlers.statusLog).toEqual([{ status: "connecting", attempts: 0 }]);

    harness.sockets[0]?.emitOpen();
    expect(handlers.statusLog.at(-1)).toEqual({ status: "open", attempts: 0 });

    harness.sockets[0]?.emitMessage(JSON.stringify(SNAPSHOT_FRAME));
    harness.sockets[0]?.emitMessage(JSON.stringify(ERROR_FRAME));
    expect(handlers.snapshots).toEqual([SNAPSHOT_FRAME]);
    expect(handlers.errors).toEqual([ERROR_FRAME]);
  });

  it("validates and serializes outbound actions", () => {
    const handlers = makeHandlers();
    const { conn, harness } = start(handlers);
    harness.sockets[0]?.emitOpen();
    conn.send({ type: "SubmitAction", action: { type: "START_GAME" } });
    expect(harness.sockets[0]?.sent).toEqual([
      JSON.stringify({ type: "SubmitAction", action: { type: "START_GAME" } }),
    ]);
  });

  it("rejects invalid outbound messages with a zod throw", () => {
    const handlers = makeHandlers();
    const { conn, harness } = start(handlers);
    harness.sockets[0]?.emitOpen();
    expect(() => conn.send({ type: "SubmitAction", action: { type: "FAKE" } } as never)).toThrow();
    expect(harness.sockets[0]?.sent).toEqual([]);
  });

  it("closes the socket with the bad-frame code on JSON parse failure", () => {
    const handlers = makeHandlers();
    const { harness } = start(handlers);
    harness.sockets[0]?.emitOpen();
    harness.sockets[0]?.emitMessage("not-json");
    expect(harness.sockets[0]?.closeCalls).toEqual([{ code: 4400, reason: "invalid JSON" }]);
  });

  it("closes the socket with the bad-frame code on schema mismatch", () => {
    const handlers = makeHandlers();
    const { harness } = start(handlers);
    harness.sockets[0]?.emitOpen();
    harness.sockets[0]?.emitMessage(JSON.stringify({ type: "WhoKnows" }));
    expect(harness.sockets[0]?.closeCalls).toEqual([{ code: 4400, reason: "schema mismatch" }]);
  });

  it("schedules a reconnect with exponential backoff after an unexpected close", () => {
    const handlers = makeHandlers();
    const { harness } = start(handlers);
    harness.sockets[0]?.emitOpen();
    harness.sockets[0]?.emitClose(1006, "boom");
    expect(handlers.statusLog.at(-1)).toEqual({ status: "closed", attempts: 0 });
    expect(harness.timers).toHaveLength(1);
    expect(harness.timers[0]?.delayMs).toBe(100);

    harness.fireTimer(0);
    expect(harness.sockets).toHaveLength(2);
    expect(handlers.statusLog.at(-1)).toEqual({ status: "connecting", attempts: 1 });

    // Second close - second backoff is 200ms.
    harness.sockets[1]?.emitClose(1006, "again");
    expect(harness.timers[1]?.delayMs).toBe(200);
  });

  it("gives up after 5 reconnect attempts and reports an error", () => {
    const handlers = makeHandlers();
    const { harness } = start(handlers);
    let lastSocket = 0;
    for (let i = 0; i < 5; i += 1) {
      harness.sockets[lastSocket]?.emitClose(1006, "boom");
      harness.fireTimer(harness.timers.length - 1);
      lastSocket += 1;
    }
    harness.sockets[lastSocket]?.emitClose(1006, "boom");
    const last = handlers.statusLog.at(-1);
    expect(last?.status).toBe("error");
    expect(last?.error).toBe("max reconnect attempts reached");
    expect(harness.timers).toHaveLength(5);
  });

  it("does not reconnect when the socket closes with the bad-frame code", () => {
    const handlers = makeHandlers();
    const { harness } = start(handlers);
    harness.sockets[0]?.emitOpen();
    harness.sockets[0]?.emitMessage("nope");
    harness.sockets[0]?.emitClose(4400, "invalid JSON");
    const last = handlers.statusLog.at(-1);
    expect(last?.status).toBe("error");
    expect(harness.timers).toHaveLength(0);
  });

  it("close() cancels pending reconnects and sends the leave code", () => {
    const handlers = makeHandlers();
    const { conn, harness } = start(handlers);
    harness.sockets[0]?.emitOpen();
    conn.close();
    expect(harness.sockets[0]?.closeCalls).toEqual([{ code: 4000, reason: "client leave" }]);
    expect(handlers.statusLog.at(-1)).toEqual({ status: "closed", attempts: 0 });

    // Subsequent close events from the underlying socket should be ignored.
    harness.sockets[0]?.emitClose(1006);
    expect(harness.timers).toHaveLength(0);
  });

  it("warns and drops a send when the socket is not open", () => {
    const handlers = makeHandlers();
    const { conn, harness } = start(handlers);
    harness.sockets[0]?.emitClose(1006, "boom");
    conn.send({ type: "SubmitAction", action: { type: "START_GAME" } });
    expect(warn).toHaveBeenCalledOnce();
  });
});
