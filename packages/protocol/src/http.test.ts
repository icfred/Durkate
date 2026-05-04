import { describe, expect, it } from "vitest";
import {
  createRoomRequestSchema,
  createRoomResponseSchema,
  normalizeCreateRoomRequest,
  parseCreateRoomRequest,
  parseCreateRoomResponse,
} from "./http";

describe("createRoomRequestSchema (legacy mode shape)", () => {
  it("accepts mode: human", () => {
    expect(parseCreateRoomRequest({ mode: "human" })).toEqual({ mode: "human" });
  });

  it("accepts mode: bot", () => {
    expect(parseCreateRoomRequest({ mode: "bot" })).toEqual({ mode: "bot" });
  });

  it("rejects unknown modes", () => {
    expect(() => parseCreateRoomRequest({ mode: "spectator" })).toThrow();
  });

  it("rejects missing mode and missing playerCount", () => {
    expect(() => createRoomRequestSchema.parse({})).toThrow();
  });

  it("accepts difficulty: easy/medium/hard for bot rooms", () => {
    expect(parseCreateRoomRequest({ mode: "bot", difficulty: "easy" })).toEqual({
      mode: "bot",
      difficulty: "easy",
    });
    expect(parseCreateRoomRequest({ mode: "bot", difficulty: "medium" })).toEqual({
      mode: "bot",
      difficulty: "medium",
    });
    expect(parseCreateRoomRequest({ mode: "bot", difficulty: "hard" })).toEqual({
      mode: "bot",
      difficulty: "hard",
    });
  });

  it("rejects unknown difficulty values", () => {
    expect(() => parseCreateRoomRequest({ mode: "bot", difficulty: "extreme" })).toThrow();
  });
});

describe("createRoomRequestSchema (N-player shape)", () => {
  it("accepts a 4-player 3-bot room", () => {
    expect(parseCreateRoomRequest({ playerCount: 4, botCount: 3 })).toEqual({
      playerCount: 4,
      botCount: 3,
    });
  });

  it("accepts a 6-player 0-bot room", () => {
    expect(parseCreateRoomRequest({ playerCount: 6, botCount: 0 })).toEqual({
      playerCount: 6,
      botCount: 0,
    });
  });

  it("accepts difficulty in N-player shape", () => {
    expect(parseCreateRoomRequest({ playerCount: 3, botCount: 2, difficulty: "hard" })).toEqual({
      playerCount: 3,
      botCount: 2,
      difficulty: "hard",
    });
  });

  it("rejects botCount === playerCount (need at least one human)", () => {
    expect(() => parseCreateRoomRequest({ playerCount: 3, botCount: 3 })).toThrow();
  });

  it("rejects playerCount outside 2..6", () => {
    expect(() => parseCreateRoomRequest({ playerCount: 7, botCount: 1 })).toThrow();
    expect(() => parseCreateRoomRequest({ playerCount: 1, botCount: 0 })).toThrow();
  });

  it("rejects negative botCount", () => {
    expect(() => parseCreateRoomRequest({ playerCount: 3, botCount: -1 })).toThrow();
  });
});

describe("normalizeCreateRoomRequest", () => {
  it("translates legacy mode: human to {playerCount:2, botCount:0}", () => {
    expect(normalizeCreateRoomRequest({ mode: "human" })).toEqual({ playerCount: 2, botCount: 0 });
  });

  it("translates legacy mode: bot to {playerCount:2, botCount:1}", () => {
    expect(normalizeCreateRoomRequest({ mode: "bot" })).toEqual({ playerCount: 2, botCount: 1 });
  });

  it("preserves difficulty across the legacy translation", () => {
    expect(normalizeCreateRoomRequest({ mode: "bot", difficulty: "hard" })).toEqual({
      playerCount: 2,
      botCount: 1,
      difficulty: "hard",
    });
  });

  it("passes N-player shape through unchanged", () => {
    expect(normalizeCreateRoomRequest({ playerCount: 5, botCount: 2 })).toEqual({
      playerCount: 5,
      botCount: 2,
    });
  });
});

describe("createRoomResponseSchema", () => {
  it("normalizes a response with only joinToken into joinTokens=[joinToken]", () => {
    const value = parseCreateRoomResponse({ roomId: "abc", hostToken: "h", joinToken: "j" });
    expect(value.joinTokens).toEqual(["j"]);
    expect(value.joinToken).toBe("j");
  });

  it("normalizes a response with only joinTokens leaves joinToken absent", () => {
    const value = parseCreateRoomResponse({
      roomId: "abc",
      hostToken: "h",
      joinTokens: ["a", "b"],
    });
    expect(value.joinTokens).toEqual(["a", "b"]);
  });

  it("normalizes a bot-only response (no joinToken/joinTokens) to empty joinTokens", () => {
    const value = parseCreateRoomResponse({ roomId: "abc", hostToken: "h" });
    expect(value.joinTokens).toEqual([]);
  });

  it("rejects empty roomId or token", () => {
    expect(() => createRoomResponseSchema.parse({ roomId: "", hostToken: "h" })).toThrow();
    expect(() => createRoomResponseSchema.parse({ roomId: "a", hostToken: "" })).toThrow();
  });
});
