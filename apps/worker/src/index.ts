import { type CreateRoomRequest, createRoomRequestSchema } from "@durak/protocol";
import { ZodError } from "zod";
import { TokenBucket } from "./rate-limit.js";
import { Room, randomBase64Url } from "./room.js";

export { Room };

interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  ALLOWED_ORIGINS?: string;
  TURN_TIMEOUT_MS?: string;
  DISCONNECT_FORFEIT_MS?: string;
}

const ROOM_ID_BYTES = 12;
const WS_PATH = /^\/ws\/([A-Za-z0-9_-]+)\/?$/;
const CREATE_RATE_LIMIT = { capacity: 10, refillIntervalMs: 60_000 };

// One bucket per source IP, kept in module scope so it survives across
// requests in the same Worker isolate. Workers may swap isolates at any time;
// the bucket is best-effort throttling, not durable rate-limiting.
const createBuckets = new Map<string, TokenBucket>();

function parseAllowedOrigins(env: Env): readonly string[] {
  const raw = env.ALLOWED_ORIGINS ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function corsHeaders(origin: string | null, allowed: readonly string[]): Record<string, string> {
  // No allowlist configured (local dev) → reflect any origin.
  if (allowed.length === 0) {
    return origin
      ? {
          "Access-Control-Allow-Origin": origin,
          Vary: "Origin",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        }
      : {};
  }
  if (origin && allowed.includes(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      Vary: "Origin",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
  }
  return {};
}

function checkWsOrigin(origin: string | null, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true;
  return typeof origin === "string" && allowed.includes(origin);
}

function getBucket(key: string): TokenBucket {
  let bucket = createBuckets.get(key);
  if (!bucket) {
    bucket = new TokenBucket(CREATE_RATE_LIMIT);
    createBuckets.set(key, bucket);
  }
  return bucket;
}

function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

const worker: ExportedHandler<Env> = {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const allowedOrigins = parseAllowedOrigins(env);
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS" && url.pathname === "/rooms") {
      const headers = corsHeaders(origin, allowedOrigins);
      if (allowedOrigins.length > 0 && Object.keys(headers).length === 0) {
        return new Response("origin not allowed", { status: 403 });
      }
      return new Response(null, { status: 204, headers });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/rooms") {
      const headers = corsHeaders(origin, allowedOrigins);
      if (origin !== null && allowedOrigins.length > 0 && Object.keys(headers).length === 0) {
        return new Response(JSON.stringify({ error: "origin not allowed" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (!getBucket(clientIp(request)).tryConsume()) {
        return new Response(JSON.stringify({ error: "rate limit exceeded" }), {
          status: 429,
          headers: { "Content-Type": "application/json", ...headers },
        });
      }

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: "invalid JSON" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...headers },
        });
      }
      let parsed: CreateRoomRequest;
      try {
        parsed = createRoomRequestSchema.parse(body);
      } catch (err) {
        const message =
          err instanceof ZodError ? (err.issues[0]?.message ?? "invalid body") : "invalid body";
        return new Response(JSON.stringify({ error: message }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...headers },
        });
      }

      const roomId = randomBase64Url(ROOM_ID_BYTES);
      const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
      const initBody: { mode: typeof parsed.mode; difficulty?: typeof parsed.difficulty } = {
        mode: parsed.mode,
      };
      if (parsed.difficulty !== undefined) initBody.difficulty = parsed.difficulty;
      const initRes = await stub.fetch("https://room/init", {
        method: "POST",
        body: JSON.stringify(initBody),
      });
      if (!initRes.ok) {
        const text = await initRes.text();
        return new Response(JSON.stringify({ error: text || "init failed" }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...headers },
        });
      }
      const created = (await initRes.json()) as Record<string, unknown>;
      // The DO returns its own id; clients address rooms by the user-facing
      // roomId (the name we hashed into the id). Override the id in the
      // response to match the public contract.
      const response = { ...created, roomId };
      return new Response(JSON.stringify(response), {
        status: 201,
        headers: { "Content-Type": "application/json", ...headers },
      });
    }

    const wsMatch = WS_PATH.exec(url.pathname);
    if (wsMatch && request.method === "GET") {
      if (!checkWsOrigin(origin, allowedOrigins)) {
        return new Response("origin not allowed", { status: 403 });
      }
      const roomId = wsMatch[1];
      if (!roomId) {
        return new Response("bad room id", { status: 400 });
      }
      const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
      const forwarded = new Request(`https://room/ws?${url.searchParams.toString()}`, request);
      return stub.fetch(forwarded);
    }

    return new Response("not found", { status: 404 });
  },
};

export default worker;
