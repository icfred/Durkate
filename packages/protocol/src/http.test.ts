import { describe, expect, it } from "vitest";
import {
  createRoomRequestSchema,
  createRoomResponseSchema,
  parseCreateRoomRequest,
  parseCreateRoomResponse,
} from "./http";

describe("createRoomRequestSchema", () => {
  it("accepts mode: human", () => {
    expect(parseCreateRoomRequest({ mode: "human" })).toEqual({ mode: "human" });
  });

  it("accepts mode: bot", () => {
    expect(parseCreateRoomRequest({ mode: "bot" })).toEqual({ mode: "bot" });
  });

  it("rejects unknown modes", () => {
    expect(() => parseCreateRoomRequest({ mode: "spectator" })).toThrow();
  });

  it("rejects missing mode", () => {
    expect(() => createRoomRequestSchema.parse({})).toThrow();
  });

  it("rejects extra fields gracefully (zod strips by default)", () => {
    expect(parseCreateRoomRequest({ mode: "bot", extra: 1 })).toEqual({ mode: "bot" });
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

  it("difficulty is optional", () => {
    expect(parseCreateRoomRequest({ mode: "bot" })).toEqual({ mode: "bot" });
  });

  it("rejects unknown difficulty values", () => {
    expect(() => parseCreateRoomRequest({ mode: "bot", difficulty: "extreme" })).toThrow();
  });
});

describe("createRoomResponseSchema", () => {
  it("accepts a bot-mode response without joinToken", () => {
    const value = parseCreateRoomResponse({ roomId: "abc", hostToken: "h" });
    expect(value).toEqual({ roomId: "abc", hostToken: "h" });
  });

  it("accepts a human-mode response with joinToken", () => {
    const value = parseCreateRoomResponse({
      roomId: "abc",
      hostToken: "h",
      joinToken: "j",
    });
    expect(value).toEqual({ roomId: "abc", hostToken: "h", joinToken: "j" });
  });

  it("rejects empty roomId or token", () => {
    expect(() => createRoomResponseSchema.parse({ roomId: "", hostToken: "h" })).toThrow();
    expect(() => createRoomResponseSchema.parse({ roomId: "a", hostToken: "" })).toThrow();
  });
});
