// Single DO alarm slot, multiple logical deadlines.
//
// Cloudflare Durable Objects expose one alarm at a time
// (`state.storage.setAlarm` / `deleteAlarm` / `alarm()`). The room needs
// several independently-scheduled deadlines: the per-turn timeout, the
// forfeit countdown when a seat disconnects, room GC, rematch timeout,
// etc. This scheduler keeps a small map keyed by deadline kind and
// arms the platform alarm at the earliest of them. When the platform
// fires the alarm, `due(now)` returns every kind whose time has
// passed; the caller dispatches each to its handler. The map is
// serialized into the room's persisted blob so deadlines survive DO
// hibernation and eviction.
export type DeadlineKind =
  | "turn-timeout"
  | "forfeit"
  // Room GC: no client ever attached within ABANDONED_MS of room creation.
  | "abandoned"
  // Room GC: all clients closed mid-game; reconnect cancels.
  | "idle"
  // Room GC: game-over has lingered without rematch / re-engagement.
  | "stale"
  // Bot pacing: pre-move "thinking" delay before a bot's next action.
  | "bot-think";

export type PersistedDeadlines = Partial<Record<DeadlineKind, number>>;

export interface AlarmStorage {
  setAlarm(time: number): void | Promise<void>;
  deleteAlarm(): void | Promise<void>;
}

export class AlarmScheduler {
  private deadlines = new Map<DeadlineKind, number>();
  private readonly storage: AlarmStorage;

  constructor(storage: AlarmStorage) {
    this.storage = storage;
  }

  load(persisted: PersistedDeadlines | null | undefined): void {
    this.deadlines.clear();
    if (!persisted) return;
    for (const [kind, at] of Object.entries(persisted)) {
      if (typeof at === "number") {
        this.deadlines.set(kind as DeadlineKind, at);
      }
    }
  }

  toPersisted(): PersistedDeadlines {
    const out: PersistedDeadlines = {};
    for (const [kind, at] of this.deadlines) out[kind] = at;
    return out;
  }

  schedule(kind: DeadlineKind, at: number): void {
    this.deadlines.set(kind, at);
    this.syncAlarm();
  }

  cancel(kind: DeadlineKind): void {
    if (!this.deadlines.delete(kind)) return;
    this.syncAlarm();
  }

  has(kind: DeadlineKind): boolean {
    return this.deadlines.has(kind);
  }

  get(kind: DeadlineKind): number | undefined {
    return this.deadlines.get(kind);
  }

  // Returns every deadline whose time has passed and removes them from
  // the map. Re-arms the platform alarm at the next-earliest, or
  // deletes it if none remain.
  due(now: number): DeadlineKind[] {
    const fired: DeadlineKind[] = [];
    for (const [kind, at] of this.deadlines) {
      if (at <= now) fired.push(kind);
    }
    for (const kind of fired) this.deadlines.delete(kind);
    this.syncAlarm();
    return fired;
  }

  private syncAlarm(): void {
    let earliest: number | null = null;
    for (const at of this.deadlines.values()) {
      if (earliest === null || at < earliest) earliest = at;
    }
    if (earliest === null) {
      void this.storage.deleteAlarm();
    } else {
      void this.storage.setAlarm(earliest);
    }
  }
}
