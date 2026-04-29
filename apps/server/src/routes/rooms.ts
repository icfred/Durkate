import { type CreateRoomResponse, createRoomRequestSchema } from "@durak/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { TokenBucket } from "../rate-limit.js";
import type { RoomRegistry } from "../rooms/RoomRegistry.js";

export interface RoomsRouteOptions {
  readonly allowedOrigins?: readonly string[];
  readonly createRateLimit?: { capacity: number; refillIntervalMs: number };
}

const DEFAULT_CREATE_RATE_LIMIT = { capacity: 10, refillIntervalMs: 60_000 };

export function registerRoomsRoutes(
  app: FastifyInstance,
  registry: RoomRegistry,
  options: RoomsRouteOptions = {},
): void {
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const rateLimit = options.createRateLimit ?? DEFAULT_CREATE_RATE_LIMIT;
  const buckets = new Map<string, TokenBucket>();

  function getBucket(key: string): TokenBucket {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket(rateLimit);
      buckets.set(key, bucket);
    }
    return bucket;
  }

  function checkOrigin(req: FastifyRequest, reply: FastifyReply): boolean {
    const origin = req.headers.origin;
    if (typeof origin !== "string") return true;
    if (allowedOrigins.size > 0 && !allowedOrigins.has(origin)) {
      void reply.code(403).send({ error: "origin not allowed" });
      return false;
    }
    reply.header("Access-Control-Allow-Origin", origin);
    reply.header("Vary", "Origin");
    reply.header("Access-Control-Allow-Methods", "POST, OPTIONS");
    reply.header("Access-Control-Allow-Headers", "Content-Type");
    return true;
  }

  app.options("/rooms", async (req, reply) => {
    if (!checkOrigin(req, reply)) return;
    await reply.code(204).send();
  });

  app.post("/rooms", async (req, reply) => {
    if (!checkOrigin(req, reply)) return;

    if (!getBucket(req.ip).tryConsume()) {
      app.log.warn({ ip: req.ip }, "rooms: rate-limited");
      await reply.code(429).send({ error: "rate limit exceeded" });
      return;
    }

    let parsed: { mode: "human" | "bot" };
    try {
      parsed = createRoomRequestSchema.parse(req.body);
    } catch (err) {
      const message =
        err instanceof ZodError ? (err.issues[0]?.message ?? "invalid body") : "invalid body";
      await reply.code(400).send({ error: message });
      return;
    }

    const room = registry.create({ mode: parsed.mode });
    const host = room.addPlayer("Host");
    const response: CreateRoomResponse = {
      roomId: room.id,
      hostToken: host.token,
    };
    if (parsed.mode === "human") {
      const guest = room.addPlayer("Guest");
      response.joinToken = guest.token;
    }
    app.log.info({ roomId: room.id, mode: parsed.mode }, "rooms: created");
    await reply.code(201).send(response);
  });
}
