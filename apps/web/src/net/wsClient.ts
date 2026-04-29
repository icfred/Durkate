import {
  type ClientMessage,
  clientMessageSchema,
  type ErrorMessage,
  type EventsMessage,
  parseServerMessage,
  type RoomStateMessage,
  type SnapshotMessage,
} from "@durak/protocol";

export type ConnectionStatus = "idle" | "connecting" | "open" | "closed" | "error";

export interface WsClientHandlers {
  onSnapshot(msg: SnapshotMessage): void;
  onEvents(msg: EventsMessage): void;
  onError(msg: ErrorMessage): void;
  onRoomState(msg: RoomStateMessage): void;
  onStatus(status: ConnectionStatus, info: { attempts: number; error?: string }): void;
}

export interface WsConnectOptions {
  roomId: string;
  token: string;
  serverUrl: string;
  handlers: WsClientHandlers;
  /** Test seam: factory for the underlying socket. Defaults to the global `WebSocket`. */
  socketFactory?: (url: string) => WsSocket;
  /** Test seam: schedules a delayed callback. Defaults to `setTimeout`. */
  schedule?: (cb: () => void, delayMs: number) => () => void;
}

export interface WsConnection {
  send(msg: ClientMessage): void;
  close(): void;
}

/**
 * Minimal subset of the browser `WebSocket` API used by `connect`. The
 * test harness provides a stand-in.
 */
export interface WsSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  set onopen(cb: ((event: unknown) => void) | null);
  set onclose(cb: ((event: { code?: number; reason?: string }) => void) | null);
  set onerror(cb: ((event: unknown) => void) | null);
  set onmessage(cb: ((event: { data: unknown }) => void) | null);
}

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BACKOFF_CAP_MS = 5000;
const CLOSE_CODE_BAD_FRAME = 4400;
const CLOSE_CODE_CLIENT_LEAVE = 4000;

export function buildSocketUrl(serverUrl: string, roomId: string, token: string): string {
  // The server route is `/ws/:roomId` — roomId is a path segment, not a query param.
  const url = new URL(serverUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${encodeURIComponent(roomId)}`;
  if (token.length > 0) url.searchParams.set("token", token);
  return url.toString();
}

export function connect(options: WsConnectOptions): WsConnection {
  const factory = options.socketFactory ?? defaultSocketFactory;
  const schedule = options.schedule ?? defaultSchedule;
  const url = buildSocketUrl(options.serverUrl, options.roomId, options.token);
  const handlers = options.handlers;

  let socket: WsSocket | null = null;
  let attempts = 0;
  let cancelReconnect: (() => void) | null = null;
  let closedByCaller = false;

  const setStatus = (status: ConnectionStatus, error?: string) => {
    handlers.onStatus(status, error === undefined ? { attempts } : { attempts, error });
  };

  const open = () => {
    if (closedByCaller) return;
    cancelReconnect?.();
    cancelReconnect = null;
    setStatus("connecting");
    const next = factory(url);
    socket = next;
    next.onopen = () => {
      attempts = 0;
      setStatus("open");
    };
    next.onmessage = (event) => onMessage(event.data);
    next.onerror = () => {
      // The follow-up `close` event drives the lifecycle; just surface the
      // error status so the UI can react.
      setStatus("error", "socket error");
    };
    next.onclose = (event) => {
      socket = null;
      if (closedByCaller) {
        setStatus("closed");
        return;
      }
      const reason = event.reason ?? "";
      const code = event.code ?? 0;
      if (code === CLOSE_CODE_BAD_FRAME) {
        setStatus("error", reason || "bad frame");
        return;
      }
      if (attempts >= MAX_RECONNECT_ATTEMPTS) {
        setStatus("error", "max reconnect attempts reached");
        return;
      }
      setStatus("closed");
      attempts += 1;
      cancelReconnect = schedule(open, backoffDelay(attempts));
    };
  };

  const onMessage = (raw: unknown) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof raw === "string" ? raw : String(raw));
    } catch (err) {
      console.error("[ws] failed to parse JSON frame", err);
      socket?.close(CLOSE_CODE_BAD_FRAME, "invalid JSON");
      return;
    }
    let result: ReturnType<typeof parseServerMessage>;
    try {
      result = parseServerMessage(parsed);
    } catch (err) {
      console.error("[ws] server message failed schema validation", err);
      socket?.close(CLOSE_CODE_BAD_FRAME, "schema mismatch");
      return;
    }
    switch (result.type) {
      case "Snapshot":
        handlers.onSnapshot(result);
        return;
      case "Events":
        handlers.onEvents(result);
        return;
      case "Error":
        handlers.onError(result);
        return;
      case "RoomState":
        handlers.onRoomState(result);
        return;
      default: {
        const exhaustive: never = result;
        throw new Error(`unhandled server message: ${JSON.stringify(exhaustive)}`);
      }
    }
  };

  const send = (msg: ClientMessage) => {
    const validated = clientMessageSchema.parse(msg);
    if (!socket) {
      console.warn("[ws] dropped outbound message; socket not open", validated);
      return;
    }
    socket.send(JSON.stringify(validated));
  };

  const close = () => {
    if (closedByCaller) return;
    closedByCaller = true;
    cancelReconnect?.();
    cancelReconnect = null;
    if (socket) {
      socket.close(CLOSE_CODE_CLIENT_LEAVE, "client leave");
      socket = null;
    }
    setStatus("closed");
  };

  open();
  return { send, close };
}

export function backoffDelay(attempt: number): number {
  if (attempt <= 0) return 0;
  const base = 100 * 2 ** (attempt - 1);
  return Math.min(base, RECONNECT_BACKOFF_CAP_MS);
}

function defaultSocketFactory(url: string): WsSocket {
  return new WebSocket(url) as unknown as WsSocket;
}

function defaultSchedule(cb: () => void, delayMs: number): () => void {
  const handle = setTimeout(cb, delayMs);
  return () => clearTimeout(handle);
}
