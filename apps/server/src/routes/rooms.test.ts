import type { AddressInfo } from "node:net";
import type { CreateRoomResponse } from "@durak/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type BuildAppOptions, type BuiltApp, buildApp } from "../app.js";

let built: BuiltApp | null = null;

afterEach(async () => {
  if (built) {
    await built.app.close();
    built = null;
  }
});

async function start(options: BuildAppOptions = {}): Promise<BuiltApp> {
  built = await buildApp({
    createRateLimit: { capacity: 1000, refillIntervalMs: 1000 },
    rateLimit: { capacity: 1000, refillIntervalMs: 1000 },
    ...options,
  });
  return built;
}

describe("POST /rooms", () => {
  it("creates a bot room and returns roomId + hostToken without joinToken", async () => {
    const { app, registry } = await start();
    const res = await app.inject({
      method: "POST",
      url: "/rooms",
      payload: { mode: "bot" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as CreateRoomResponse;
    expect(typeof body.roomId).toBe("string");
    expect(body.roomId.length).toBeGreaterThan(0);
    expect(typeof body.hostToken).toBe("string");
    expect(body.joinToken).toBeUndefined();

    const room = registry.get(body.roomId);
    expect(room).toBeDefined();
    expect(room?.mode).toBe("bot");
    expect(room?.seatForToken(body.hostToken)).toBe(0);
  });

  it("creates a human room and returns hostToken + joinToken", async () => {
    const { app, registry } = await start();
    const res = await app.inject({
      method: "POST",
      url: "/rooms",
      payload: { mode: "human" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as CreateRoomResponse;
    expect(typeof body.joinToken).toBe("string");
    expect(body.joinToken).not.toBe(body.hostToken);

    const room = registry.get(body.roomId);
    expect(room).toBeDefined();
    expect(room?.mode).toBe("human");
    expect(room?.seatForToken(body.hostToken)).toBe(0);
    expect(body.joinToken !== undefined && room?.seatForToken(body.joinToken)).toBe(1);
  });

  it("rejects unknown modes with 400", async () => {
    const { app } = await start();
    const res = await app.inject({
      method: "POST",
      url: "/rooms",
      payload: { mode: "spectator" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects empty body with 400", async () => {
    const { app } = await start();
    const res = await app.inject({ method: "POST", url: "/rooms", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("rate-limits create-room requests per IP with 429", async () => {
    const { app } = await start({ createRateLimit: { capacity: 2, refillIntervalMs: 60_000 } });
    const ok1 = await app.inject({
      method: "POST",
      url: "/rooms",
      payload: { mode: "bot" },
      remoteAddress: "10.0.0.1",
    });
    const ok2 = await app.inject({
      method: "POST",
      url: "/rooms",
      payload: { mode: "bot" },
      remoteAddress: "10.0.0.1",
    });
    const limited = await app.inject({
      method: "POST",
      url: "/rooms",
      payload: { mode: "bot" },
      remoteAddress: "10.0.0.1",
    });
    expect(ok1.statusCode).toBe(201);
    expect(ok2.statusCode).toBe(201);
    expect(limited.statusCode).toBe(429);

    const otherIp = await app.inject({
      method: "POST",
      url: "/rooms",
      payload: { mode: "bot" },
      remoteAddress: "10.0.0.2",
    });
    expect(otherIp.statusCode).toBe(201);
  });

  it("rejects POST from a disallowed origin with 403", async () => {
    const { app } = await start({ allowedOrigins: ["https://app.example.com"] });
    const res = await app.inject({
      method: "POST",
      url: "/rooms",
      payload: { mode: "bot" },
      headers: { origin: "https://evil.example.com" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("accepts POST from an allowed origin and returns CORS headers", async () => {
    const { app } = await start({ allowedOrigins: ["https://app.example.com"] });
    const res = await app.inject({
      method: "POST",
      url: "/rooms",
      payload: { mode: "bot" },
      headers: { origin: "https://app.example.com" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers["access-control-allow-origin"]).toBe("https://app.example.com");
  });

  it("answers OPTIONS preflight with 204 + CORS headers", async () => {
    const { app } = await start({ allowedOrigins: ["https://app.example.com"] });
    const res = await app.inject({
      method: "OPTIONS",
      url: "/rooms",
      headers: {
        origin: "https://app.example.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("https://app.example.com");
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
    expect(res.headers["access-control-allow-headers"]).toContain("Content-Type");
  });

  it("OPTIONS preflight from disallowed origin yields 403", async () => {
    const { app } = await start({ allowedOrigins: ["https://app.example.com"] });
    const res = await app.inject({
      method: "OPTIONS",
      url: "/rooms",
      headers: { origin: "https://evil.example.com" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /rooms + ws integration", () => {
  it("bot mode: created room is joinable via ws with hostToken and starts a game", async () => {
    const app = await start();
    await app.app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.app.server.address() as AddressInfo;
    const baseHttp = `http://127.0.0.1:${addr.port}`;
    const baseWs = `ws://127.0.0.1:${addr.port}`;

    const createRes = await fetch(`${baseHttp}/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "bot" }),
    });
    expect(createRes.status).toBe(201);
    const body = (await createRes.json()) as CreateRoomResponse;
    expect(body.joinToken).toBeUndefined();

    const ws = new WebSocket(
      `${baseWs}/ws/${encodeURIComponent(body.roomId)}?token=${body.hostToken}`,
    );
    const opened = new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (err) => reject(err));
    });
    await opened;
    ws.close();
    await new Promise<void>((resolve) => ws.once("close", () => resolve()));
  });

  it("human mode: two clients connect with hostToken/joinToken and play a full game", async () => {
    const app = await start();
    await app.app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.app.server.address() as AddressInfo;
    const baseHttp = `http://127.0.0.1:${addr.port}`;
    const baseWs = `ws://127.0.0.1:${addr.port}`;

    const createRes = await fetch(`${baseHttp}/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "human" }),
    });
    expect(createRes.status).toBe(201);
    const body = (await createRes.json()) as CreateRoomResponse;
    if (!body.joinToken) throw new Error("expected joinToken");

    const wsHost = new WebSocket(
      `${baseWs}/ws/${encodeURIComponent(body.roomId)}?token=${body.hostToken}`,
    );
    const wsGuest = new WebSocket(
      `${baseWs}/ws/${encodeURIComponent(body.roomId)}?token=${body.joinToken}`,
    );

    await Promise.all([
      new Promise<void>((resolve, reject) => {
        wsHost.once("open", () => resolve());
        wsHost.once("error", (err) => reject(err));
      }),
      new Promise<void>((resolve, reject) => {
        wsGuest.once("open", () => resolve());
        wsGuest.once("error", (err) => reject(err));
      }),
    ]);

    // The room should now have both seats attached and a game in progress.
    const room = app.registry.get(body.roomId);
    expect(room).toBeDefined();
    expect(room?.bothSeatsFilled()).toBe(true);

    wsHost.close();
    wsGuest.close();
    await Promise.all([
      new Promise<void>((resolve) => wsHost.once("close", () => resolve())),
      new Promise<void>((resolve) => wsGuest.once("close", () => resolve())),
    ]);
  });
});
