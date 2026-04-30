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
  it("POSTs to /rooms with the requested mode and parses the response", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ roomId: "abc", hostToken: "h", joinToken: "j" }, { status: 201 });
    }) as typeof fetch;

    const result = await createRoom("human", { serverUrl: "http://server.test", fetchImpl });

    expect(result).toEqual({ roomId: "abc", hostToken: "h", joinToken: "j" });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error("expected call");
    expect(call.url).toBe("http://server.test/rooms");
    expect(call.init?.method).toBe("POST");
    expect(call.init?.body).toBe('{"mode":"human"}');
  });

  it("converts ws:// server URL to http:// for the fetch", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: RequestInfo | URL) => {
      seen.push(String(url));
      return jsonResponse({ roomId: "x", hostToken: "y" }, { status: 201 });
    }) as typeof fetch;
    await createRoom("bot", { serverUrl: "ws://server.test/ws", fetchImpl });
    expect(seen[0]).toBe("http://server.test/rooms");
  });

  it("throws CreateRoomError with status on a non-2xx response", async () => {
    const fetchImpl = (async () => new Response("rate limited", { status: 429 })) as typeof fetch;
    await expect(createRoom("bot", { serverUrl: "http://s", fetchImpl })).rejects.toMatchObject({
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
    await expect(createRoom("bot", { serverUrl: "http://s", fetchImpl })).rejects.toBeInstanceOf(
      CreateRoomError,
    );
  });

  it("throws CreateRoomError when the response shape fails the schema", async () => {
    const fetchImpl = (async () => jsonResponse({ roomId: "" }, { status: 201 })) as typeof fetch;
    await expect(createRoom("bot", { serverUrl: "http://s", fetchImpl })).rejects.toBeInstanceOf(
      CreateRoomError,
    );
  });

  it("includes difficulty for bot rooms when provided", async () => {
    const calls: { body: string }[] = [];
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ body: String(init?.body) });
      return jsonResponse({ roomId: "x", hostToken: "y" }, { status: 201 });
    }) as typeof fetch;
    await createRoom("bot", { serverUrl: "http://s", fetchImpl, difficulty: "hard" });
    expect(calls[0]?.body).toBe('{"mode":"bot","difficulty":"hard"}');
  });

  it("omits difficulty for human rooms even when provided", async () => {
    const calls: { body: string }[] = [];
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ body: String(init?.body) });
      return jsonResponse({ roomId: "x", hostToken: "y", joinToken: "j" }, { status: 201 });
    }) as typeof fetch;
    await createRoom("human", { serverUrl: "http://s", fetchImpl, difficulty: "hard" });
    expect(calls[0]?.body).toBe('{"mode":"human"}');
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
