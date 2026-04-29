import { describe, expect, it } from "vitest";
import { RoomRegistry } from "./RoomRegistry.js";

describe("RoomRegistry", () => {
  it("creates rooms with unique ids", () => {
    const registry = new RoomRegistry();
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(registry.create().id);
    }
    expect(ids.size).toBe(100);
  });

  it("get returns the same room previously created", () => {
    const registry = new RoomRegistry();
    const room = registry.create();
    expect(registry.get(room.id)).toBe(room);
  });

  it("get returns undefined for unknown ids", () => {
    const registry = new RoomRegistry();
    expect(registry.get("nope")).toBeUndefined();
  });

  it("delete removes the room and reports whether it existed", () => {
    const registry = new RoomRegistry();
    const room = registry.create();
    expect(registry.delete(room.id)).toBe(true);
    expect(registry.get(room.id)).toBeUndefined();
    expect(registry.delete(room.id)).toBe(false);
  });

  it("size reflects current room count", () => {
    const registry = new RoomRegistry();
    expect(registry.size()).toBe(0);
    const a = registry.create();
    registry.create();
    expect(registry.size()).toBe(2);
    registry.delete(a.id);
    expect(registry.size()).toBe(1);
  });
});
