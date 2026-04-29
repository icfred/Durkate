import { describe, expect, it } from "vitest";
import type { JoinRoom, LeaveRoom, RequestRematch, SubmitAction } from "./client";
import type { ErrorMessage, EventsMessage, RoomStateMessage, SnapshotMessage } from "./server";
import type { Snapshot } from "./snapshot";
import {
  clientMessageSchema,
  parseClientMessage,
  parseServerMessage,
  serverMessageSchema,
} from "./zod";

const ACE_OF_SPADES = { suit: "spades", rank: 14 } as const;

function makeSnapshot(): Snapshot {
  return {
    phase: "in-round",
    playerCount: 2,
    handCounts: [6, 6],
    talonCount: 23,
    trump: ACE_OF_SPADES,
    table: [],
    attacker: 0,
    defender: 1,
    discard: [],
    seat: 0,
    you: { seat: 0, hand: [ACE_OF_SPADES] },
  };
}

describe("clientMessageSchema round-trip", () => {
  it("accepts JoinRoom", () => {
    const msg: JoinRoom = { type: "JoinRoom", roomId: "abc", name: "fred" };
    expect(clientMessageSchema.parse(msg)).toEqual(msg);
  });

  it("accepts JoinRoom with mode: 'human'", () => {
    const msg: JoinRoom = { type: "JoinRoom", roomId: "abc", name: "fred", mode: "human" };
    expect(clientMessageSchema.parse(msg)).toEqual(msg);
  });

  it("accepts JoinRoom with mode: 'bot'", () => {
    const msg: JoinRoom = { type: "JoinRoom", roomId: "abc", name: "fred", mode: "bot" };
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

  it("rejects JoinRoom with unknown mode", () => {
    expect(() =>
      clientMessageSchema.parse({
        type: "JoinRoom",
        roomId: "abc",
        name: "fred",
        mode: "spectator",
      }),
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

describe("serverMessageSchema round-trip", () => {
  it("accepts Snapshot", () => {
    const msg: SnapshotMessage = { type: "Snapshot", snapshot: makeSnapshot() };
    expect(serverMessageSchema.parse(msg)).toEqual(msg);
  });

  it("accepts Events with engine Event union", () => {
    const msg: EventsMessage = {
      type: "Events",
      events: [
        { type: "GAME_STARTED", trump: ACE_OF_SPADES, attacker: 0 },
        {
          type: "CARD_PLAYED",
          by: 0,
          role: "ATTACK",
          card: ACE_OF_SPADES,
        },
        {
          type: "PILE_TAKEN",
          by: 1,
          cards: [ACE_OF_SPADES],
          attacker: 1,
          defender: 0,
        },
        {
          type: "ROUND_ENDED",
          discarded: [],
          attacker: 1,
          defender: 0,
        },
      ],
    };
    expect(serverMessageSchema.parse(msg)).toEqual(msg);
  });

  it("accepts Error", () => {
    const msg: ErrorMessage = { type: "Error", code: "BAD_ACTION", message: "nope" };
    expect(serverMessageSchema.parse(msg)).toEqual(msg);
  });

  it("accepts RoomState", () => {
    const msg: RoomStateMessage = {
      type: "RoomState",
      roomId: "ABCD",
      seats: [{ name: "fred" }, { name: null }],
      you: 0,
    };
    expect(serverMessageSchema.parse(msg)).toEqual(msg);
  });

  it("parseServerMessage exposes the same parser", () => {
    expect(parseServerMessage({ type: "Error", code: "X", message: "y" })).toEqual({
      type: "Error",
      code: "X",
      message: "y",
    });
  });
});

describe("serverMessageSchema rejects malformed input", () => {
  it("rejects unknown discriminator", () => {
    expect(() => serverMessageSchema.parse({ type: "Nope" })).toThrow();
  });

  it("rejects Snapshot with missing trump", () => {
    const bad = { type: "Snapshot", snapshot: { ...makeSnapshot(), trump: undefined } };
    expect(() => serverMessageSchema.parse(bad)).toThrow();
  });

  it("rejects Events with invalid event type", () => {
    expect(() =>
      serverMessageSchema.parse({
        type: "Events",
        events: [{ type: "BLEW_UP" }],
      }),
    ).toThrow();
  });

  it("rejects RoomState with non-string roomId", () => {
    expect(() =>
      serverMessageSchema.parse({
        type: "RoomState",
        roomId: 42,
        seats: [],
        you: null,
      }),
    ).toThrow();
  });
});
