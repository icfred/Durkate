import { describe, expect, it } from "vitest";
import { Room, RoomFullError } from "./Room.js";

describe("Room", () => {
  it("seats two players in order and issues distinct tokens", () => {
    const room = new Room();
    const a = room.addPlayer("alice");
    const b = room.addPlayer("bob");
    expect(a.seat).toBe(0);
    expect(b.seat).toBe(1);
    expect(a.token).not.toBe(b.token);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("rejects a third player", () => {
    const room = new Room();
    room.addPlayer("alice");
    room.addPlayer("bob");
    expect(() => room.addPlayer("carol")).toThrow(RoomFullError);
  });

  it("frees the seat on removePlayer and lets a new player take it", () => {
    const room = new Room();
    const a = room.addPlayer("alice");
    room.addPlayer("bob");
    expect(room.removePlayer(a.token)).toBe(true);
    const c = room.addPlayer("carol");
    expect(c.seat).toBe(0);
  });

  it("removePlayer returns false for an unknown token", () => {
    const room = new Room();
    room.addPlayer("alice");
    expect(room.removePlayer("not-a-real-token")).toBe(false);
  });

  it("seatForToken resolves a seated token and returns undefined otherwise", () => {
    const room = new Room();
    const a = room.addPlayer("alice");
    const b = room.addPlayer("bob");
    expect(room.seatForToken(a.token)).toBe(0);
    expect(room.seatForToken(b.token)).toBe(1);
    expect(room.seatForToken("nope")).toBeUndefined();
  });

  it("issues globally unique tokens across many joins", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const room = new Room();
      tokens.add(room.addPlayer("p1").token);
      tokens.add(room.addPlayer("p2").token);
    }
    expect(tokens.size).toBe(400);
  });

  it("attach/detach client tracks per-seat handles", () => {
    const room = new Room();
    const a = room.addPlayer("alice");
    const sent: string[] = [];
    const handle = {
      send: (payload: string) => sent.push(payload),
      close: () => {},
    };
    room.attachClient(a.seat, handle);
    expect(room.clientForSeat(a.seat)).toBe(handle);
    room.detachClient(a.seat);
    expect(room.clientForSeat(a.seat)).toBeUndefined();
  });

  it("removePlayer also clears any attached client for the seat", () => {
    const room = new Room();
    const a = room.addPlayer("alice");
    room.attachClient(a.seat, { send: () => {}, close: () => {} });
    room.removePlayer(a.token);
    expect(room.clientForSeat(a.seat)).toBeUndefined();
  });
});
