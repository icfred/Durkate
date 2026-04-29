import type { AddressInfo } from "node:net";
import type { ErrorMessage, RoomStateMessage, ServerMessage } from "@durak/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type BuiltApp, buildApp } from "./app.js";

let built: BuiltApp | null = null;

afterEach(async () => {
  if (built) {
    await built.app.close();
    built = null;
  }
});

async function start(): Promise<{ wsUrl: (path: string) => string; built: BuiltApp }> {
  built = await buildApp();
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  const addr = built.app.server.address() as AddressInfo;
  const wsUrl = (path: string) => `ws://127.0.0.1:${addr.port}${path}`;
  return { wsUrl, built };
}

function nextOpen(client: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    client.once("open", () => resolve());
    client.once("error", (err) => reject(err));
  });
}

function nextMessage(client: WebSocket, timeoutMs = 1000): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws message timeout")), timeoutMs);
    const onMessage = (data: WebSocket.RawData) => {
      cleanup();
      try {
        resolve(JSON.parse(data.toString()) as ServerMessage);
      } catch (err) {
        reject(err);
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      clearTimeout(timer);
      client.off("message", onMessage);
      client.off("error", onError);
    };
    client.on("message", onMessage);
    client.on("error", onError);
  });
}

function nextClose(client: WebSocket, timeoutMs = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws close timeout")), timeoutMs);
    client.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

describe("gateway /ws/:roomId", () => {
  it("two clients with valid tokens both join the same room and receive RoomState", async () => {
    const { wsUrl, built } = await start();
    const room = built.registry.create();
    const a = room.addPlayer("alice");
    const b = room.addPlayer("bob");

    const ca = new WebSocket(wsUrl(`/ws/${room.id}?token=${a.token}`));
    const stateA1Promise = nextMessage(ca);
    await nextOpen(ca);
    const stateA1 = (await stateA1Promise) as RoomStateMessage;
    expect(stateA1.type).toBe("RoomState");
    expect(stateA1.you).toBe(0);
    expect(stateA1.seats.map((s) => s.name)).toEqual(["alice", "bob"]);

    const stateA2Promise = nextMessage(ca);
    const cb = new WebSocket(wsUrl(`/ws/${room.id}?token=${b.token}`));
    const stateB1Promise = nextMessage(cb);
    await nextOpen(cb);
    const stateA2 = (await stateA2Promise) as RoomStateMessage;
    const stateB1 = (await stateB1Promise) as RoomStateMessage;
    expect(stateA2.type).toBe("RoomState");
    expect(stateA2.you).toBe(0);
    expect(stateB1.type).toBe("RoomState");
    expect(stateB1.you).toBe(1);

    ca.close();
    cb.close();
    await Promise.all([nextClose(ca), nextClose(cb)]);
  });

  it("rejects connection to an unknown room", async () => {
    const { wsUrl } = await start();
    const c = new WebSocket(wsUrl("/ws/does-not-exist?token=anything"));
    const closed = nextClose(c);
    const msg = (await nextMessage(c)) as ErrorMessage;
    expect(msg.type).toBe("Error");
    expect(msg.code).toBe("ROOM_NOT_FOUND");
    await closed;
  });

  it("rejects connection with a forged token", async () => {
    const { wsUrl, built } = await start();
    const room = built.registry.create();
    room.addPlayer("alice");
    const c = new WebSocket(wsUrl(`/ws/${room.id}?token=not-a-real-token`));
    const closed = nextClose(c);
    const msg = (await nextMessage(c)) as ErrorMessage;
    expect(msg.type).toBe("Error");
    expect(msg.code).toBe("BAD_TOKEN");
    await closed;
  });

  it("malformed JSON yields Error and closes the socket", async () => {
    const { wsUrl, built } = await start();
    const room = built.registry.create();
    const a = room.addPlayer("alice");
    const c = new WebSocket(wsUrl(`/ws/${room.id}?token=${a.token}`));
    const initialState = nextMessage(c);
    await nextOpen(c);
    await initialState;

    const errorMsg = nextMessage(c);
    const closed = nextClose(c);
    c.send("not json at all");
    const msg = (await errorMsg) as ErrorMessage;
    expect(msg.type).toBe("Error");
    expect(msg.code).toBe("BAD_MESSAGE");
    await closed;
  });

  it("Zod-invalid message yields Error and closes the socket", async () => {
    const { wsUrl, built } = await start();
    const room = built.registry.create();
    const a = room.addPlayer("alice");
    const c = new WebSocket(wsUrl(`/ws/${room.id}?token=${a.token}`));
    const initialState = nextMessage(c);
    await nextOpen(c);
    await initialState;

    const errorMsg = nextMessage(c);
    const closed = nextClose(c);
    c.send(JSON.stringify({ type: "JoinRoom", roomId: 5 }));
    const msg = (await errorMsg) as ErrorMessage;
    expect(msg.type).toBe("Error");
    expect(msg.code).toBe("BAD_MESSAGE");
    await closed;
  });

  it("SubmitAction is dispatched to the engine stub and a Snapshot is echoed", async () => {
    const { wsUrl, built } = await start();
    const room = built.registry.create();
    const a = room.addPlayer("alice");
    const c = new WebSocket(wsUrl(`/ws/${room.id}?token=${a.token}`));
    const initialState = nextMessage(c);
    await nextOpen(c);
    await initialState;

    const snapshotMsg = nextMessage(c);
    c.send(JSON.stringify({ type: "SubmitAction", action: { type: "START_GAME" } }));
    const msg = await snapshotMsg;
    expect(msg.type).toBe("Snapshot");
    if (msg.type === "Snapshot") {
      expect(msg.snapshot.seat).toBe(0);
      expect(msg.snapshot.you.seat).toBe(0);
    }

    c.close();
    await nextClose(c);
  });

  it("gateway.send delivers a per-seat message to the connected client", async () => {
    const { wsUrl, built } = await start();
    const room = built.registry.create();
    const a = room.addPlayer("alice");
    const c = new WebSocket(wsUrl(`/ws/${room.id}?token=${a.token}`));
    const initialState = nextMessage(c);
    await nextOpen(c);
    await initialState;

    const echo = nextMessage(c);
    built.gateway.send(room.id, 0, {
      type: "Error",
      code: "TEST",
      message: "hello",
    });
    const msg = (await echo) as ErrorMessage;
    expect(msg.type).toBe("Error");
    expect(msg.code).toBe("TEST");
    expect(msg.message).toBe("hello");

    c.close();
    await nextClose(c);
  });
});
