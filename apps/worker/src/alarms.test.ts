import { describe, expect, it } from "vitest";
import { AlarmScheduler, type AlarmStorage, type DeadlineKind } from "./alarms.js";

class FakeStorage implements AlarmStorage {
  alarmAt: number | null = null;
  setAlarmCalls = 0;
  deleteAlarmCalls = 0;

  setAlarm(time: number): void {
    this.alarmAt = time;
    this.setAlarmCalls += 1;
  }

  deleteAlarm(): void {
    this.alarmAt = null;
    this.deleteAlarmCalls += 1;
  }
}

describe("AlarmScheduler", () => {
  it("arms the platform alarm at the earliest deadline", () => {
    const storage = new FakeStorage();
    const sched = new AlarmScheduler(storage);
    sched.schedule("turn-timeout", 2000);
    expect(storage.alarmAt).toBe(2000);
    sched.schedule("forfeit", 1000);
    expect(storage.alarmAt).toBe(1000);
  });

  it("re-arms when an earlier deadline is canceled", () => {
    const storage = new FakeStorage();
    const sched = new AlarmScheduler(storage);
    sched.schedule("turn-timeout", 2000);
    sched.schedule("forfeit", 1000);
    sched.cancel("forfeit");
    expect(storage.alarmAt).toBe(2000);
  });

  it("clears the platform alarm when nothing remains", () => {
    const storage = new FakeStorage();
    const sched = new AlarmScheduler(storage);
    sched.schedule("forfeit", 1000);
    sched.cancel("forfeit");
    expect(storage.alarmAt).toBeNull();
    expect(storage.deleteAlarmCalls).toBeGreaterThan(0);
  });

  it("due() returns and removes only deadlines that have passed", () => {
    const storage = new FakeStorage();
    const sched = new AlarmScheduler(storage);
    sched.schedule("turn-timeout", 1000);
    sched.schedule("forfeit", 5000);
    const fired: DeadlineKind[] = sched.due(1500);
    expect(fired).toEqual(["turn-timeout"]);
    expect(sched.has("forfeit")).toBe(true);
    expect(storage.alarmAt).toBe(5000);
  });

  it("due() returning all empties the schedule and deletes the alarm", () => {
    const storage = new FakeStorage();
    const sched = new AlarmScheduler(storage);
    sched.schedule("forfeit", 1000);
    sched.due(2000);
    expect(sched.has("forfeit")).toBe(false);
    expect(storage.alarmAt).toBeNull();
  });

  it("survives a load/persist round-trip", () => {
    const a = new FakeStorage();
    const sched = new AlarmScheduler(a);
    sched.schedule("turn-timeout", 1000);
    sched.schedule("forfeit", 5000);
    const blob = sched.toPersisted();

    const b = new FakeStorage();
    const restored = new AlarmScheduler(b);
    restored.load(blob);
    expect(restored.get("turn-timeout")).toBe(1000);
    expect(restored.get("forfeit")).toBe(5000);
  });

  it("load(null) leaves the schedule empty", () => {
    const storage = new FakeStorage();
    const sched = new AlarmScheduler(storage);
    sched.load(null);
    expect(sched.has("turn-timeout")).toBe(false);
    expect(sched.has("forfeit")).toBe(false);
  });
});
