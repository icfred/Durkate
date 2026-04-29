import { describe, expect, it } from "vitest";
import type { JoinRoom, LeaveRoom, RequestRematch, SubmitAction } from "./client";
import { clientMessageSchema, parseClientMessage } from "./zod";

describe("clientMessageSchema round-trip", () => {
  it("accepts JoinRoom", () => {
    const msg: JoinRoom = { type: "JoinRoom", roomId: "abc", name: "fred" };
    expect(clientMessageSchema.parse(msg)).toEqual(msg);
  });

  it("accepts LeaveRoom", () => {
    const msg: LeaveRoom = { type: "LeaveRoom" };
    expect(clientMessageSchema.parse(msg)).toEqual(msg);
  });

  it("accepts SubmitAction with engine Action", () => {
    const msg: SubmitAction = {
      type: "SubmitAction",
      action: { type: "START_GAME" },
    };
    expect(clientMessageSchema.parse(msg)).toEqual(msg);
  });

  it("accepts RequestRematch", () => {
    const msg: RequestRematch = { type: "RequestRematch" };
    expect(clientMessageSchema.parse(msg)).toEqual(msg);
  });

  it("parseClientMessage exposes the same parser", () => {
    expect(parseClientMessage({ type: "LeaveRoom" })).toEqual({
      type: "LeaveRoom",
    });
  });
});

describe("clientMessageSchema rejects malformed input", () => {
  it("rejects unknown discriminator", () => {
    expect(() => clientMessageSchema.parse({ type: "Nope" })).toThrow();
  });

  it("rejects missing discriminator", () => {
    expect(() => clientMessageSchema.parse({ roomId: "x", name: "y" })).toThrow();
  });

  it("rejects JoinRoom missing roomId", () => {
    expect(() => clientMessageSchema.parse({ type: "JoinRoom", name: "fred" })).toThrow();
  });

  it("rejects JoinRoom with empty name", () => {
    expect(() =>
      clientMessageSchema.parse({ type: "JoinRoom", roomId: "abc", name: "" }),
    ).toThrow();
  });

  it("rejects JoinRoom with wrong-typed roomId", () => {
    expect(() =>
      clientMessageSchema.parse({ type: "JoinRoom", roomId: 42, name: "fred" }),
    ).toThrow();
  });

  it("rejects SubmitAction with unknown action type", () => {
    expect(() =>
      clientMessageSchema.parse({
        type: "SubmitAction",
        action: { type: "FLY_TO_THE_MOON" },
      }),
    ).toThrow();
  });

  it("rejects SubmitAction missing action", () => {
    expect(() => clientMessageSchema.parse({ type: "SubmitAction" })).toThrow();
  });

  it("rejects non-object input", () => {
    expect(() => clientMessageSchema.parse("LeaveRoom")).toThrow();
    expect(() => clientMessageSchema.parse(null)).toThrow();
  });
});
