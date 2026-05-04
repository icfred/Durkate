import { describe, expect, it } from "vitest";
import { CreateRoomError, createRoom, httpFromWsUrl } from "./rooms.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("createRoom", () => {
  it("POSTs to /rooms with the requested player and bot counts", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ roomId: "abc", hostToken: "h", joinTokens: ["j"] }, { status: 201 });
    }) as typeof fetch;

    const result = await createRoom({
      serverUrl: "http://server.test",
      playerCount: 2,
      botCount: 0,
      fetchImpl,
    });

    expect(result).toMatchObject({ roomId: "abc", hostToken: "h", joinTokens: ["j"] });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error("expected call");
    expect(call.url).toBe("http://server.test/rooms");
    expect(call.init?.method).toBe("POST");
    expect(call.init?.body).toBe('{"playerCount":2,"botCount":0}');
  });

  it("converts ws:// server URL to http:// for the fetch", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: RequestInfo | URL) => {
      seen.push(String(url));
      return jsonResponse({ roomId: "x", hostToken: "y" }, { status: 201 });
    }) as typeof fetch;
    await createRoom({
      serverUrl: "ws://server.test/ws",
      playerCount: 2,
      botCount: 1,
      difficulty: "medium",
      fetchImpl,
    });
    expect(seen[0]).toBe("http://server.test/rooms");
  });

  it("throws CreateRoomError with status on a non-2xx response", async () => {
    const fetchImpl = (async () => new Response("rate limited", { status: 429 })) as typeof fetch;
    await expect(
      createRoom({ serverUrl: "http://s", playerCount: 2, botCount: 1, fetchImpl }),
    ).rejects.toMatchObject({
      name: "CreateRoomError",
      status: 429,
    });
  });

  it("throws CreateRoomError when the response body is not valid JSON", async () => {
    const fetchImpl = (async () =>
      new Response("not json", {
        status: 201,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    await expect(
      createRoom({ serverUrl: "http://s", playerCount: 2, botCount: 1, fetchImpl }),
    ).rejects.toBeInstanceOf(CreateRoomError);
  });

  it("throws CreateRoomError when the response shape fails the schema", async () => {
    const fetchImpl = (async () => jsonResponse({ roomId: "" }, { status: 201 })) as typeof fetch;
    await expect(
      createRoom({ serverUrl: "http://s", playerCount: 2, botCount: 1, fetchImpl }),
    ).rejects.toBeInstanceOf(CreateRoomError);
  });

  it("includes difficulty when bots are present", async () => {
    const calls: { body: string }[] = [];
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ body: String(init?.body) });
      return jsonResponse({ roomId: "x", hostToken: "y" }, { status: 201 });
    }) as typeof fetch;
    await createRoom({
      serverUrl: "http://s",
      playerCount: 2,
      botCount: 1,
      difficulty: "hard",
      fetchImpl,
    });
    expect(calls[0]?.body).toBe('{"playerCount":2,"botCount":1,"difficulty":"hard"}');
  });

  it("omits difficulty when there are no bots", async () => {
    const calls: { body: string }[] = [];
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ body: String(init?.body) });
      return jsonResponse({ roomId: "x", hostToken: "y", joinTokens: ["j"] }, { status: 201 });
    }) as typeof fetch;
    await createRoom({
      serverUrl: "http://s",
      playerCount: 2,
      botCount: 0,
      difficulty: "hard",
      fetchImpl,
    });
    expect(calls[0]?.body).toBe('{"playerCount":2,"botCount":0}');
  });

  it("forwards FFA shape to the worker", async () => {
    const calls: { body: string }[] = [];
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ body: String(init?.body) });
      return jsonResponse({ roomId: "x", hostToken: "h", joinTokens: ["a", "b"] }, { status: 201 });
    }) as typeof fetch;
    const response = await createRoom({
      serverUrl: "http://s",
      playerCount: 4,
      botCount: 1,
      difficulty: "medium",
      fetchImpl,
    });
    expect(calls[0]?.body).toBe('{"playerCount":4,"botCount":1,"difficulty":"medium"}');
    expect(response.joinTokens).toEqual(["a", "b"]);
  });
});

describe("httpFromWsUrl", () => {
  it("rewrites ws:// to http://", () => {
    expect(httpFromWsUrl("ws://server.test/ws")).toBe("http://server.test/");
  });

  it("rewrites wss:// to https://", () => {
    expect(httpFromWsUrl("wss://server.test/ws")).toBe("https://server.test/");
  });

  it("strips path, search, hash", () => {
    expect(httpFromWsUrl("ws://server.test:3001/ws/abc?token=x#frag")).toBe(
      "http://server.test:3001/",
    );
  });
});
