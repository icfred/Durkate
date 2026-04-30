# ADR-0009: Disconnect forfeit policy

**Status:** Accepted
**Date:** 2026-04-30

## Context

`docs/project_mvp.md` flags full mid-game reconnect recovery as post-MVP
but explicitly leaves the *minimum* disconnect behavior as an open
question. After DUR-38 moved hosting onto Cloudflare Workers + Durable
Objects, the DO's `webSocketClose` handler simply lets the seat detach;
the engine state stays put. If the seat that disconnected was the active
actor, the surviving player stares at a frozen game.

Friend playtests will hit this on the first session.

## Options considered

1. **Forfeit on disconnect, no grace.** Simplest. A blip in wifi ends
   the game.
2. **Pause on disconnect, wait forever.** Also simple. The remaining
   player has no way to leave cleanly; rage-quit becomes a denial-of-
   service against the other player.
3. **Grace window, then forfeit.** Reconnect with the same seat token
   inside the window resumes the game. After the window, the absent
   seat is declared the durak. Bounded wait, brief blips survive.

## Decision

Option 3 with a 30 s grace window.

- On `webSocketClose` for a human seat while the engine is
  `phase: "in-round"`: schedule a forfeit deadline at `now + 30_000`,
  record `disconnect = { seat, forfeitAt }` on the room, and broadcast
  `RoomState` to the surviving seat with the disconnect populated.
- On a fresh `webSocketUpgrade` with the same seat token before the
  deadline: cancel the deadline, clear `disconnect`, broadcast
  `RoomState` again. The game resumes from the engine state already
  in memory.
- On the deadline firing: synthesize a forfeit transition entirely in
  the worker. Build a `GameOverState` from the in-round state with
  `durak: <disconnected seat>` and emit a `GAME_OVER` event with the
  same seat. The engine package is not touched.

The forfeit transition does not go through `step`. The engine stays
pure. Adding a `FORFEIT` action would force the engine to know about
network disconnects - a leak. Synthesizing `GameOverState` directly
mirrors what the engine already produces from `END_ROUND`-driven game
overs (see `finalizeRoundEnd` in `packages/engine/src/step.ts`), so the
client receives the same protocol shape it already handles.

A single DO Alarms slot is shared between the turn timer and the
forfeit deadline (and any future deadlines like room GC or rematch
timeout) via `apps/worker/src/alarms.ts`. The scheduler keeps the
earliest deadline armed and replays each fired kind through a small
dispatch in `Room.alarm()`.

The grace window is fixed at 30 s for MVP. Per-room or per-mode tuning
is post-MVP.

## Consequences

- `RoomStateMessage` gains an optional
  `disconnect: { seat: SeatIndex; forfeitAt: number } | null` field.
  `forfeitAt` is an absolute epoch ms so the client can render a live
  countdown without a server tick.
- `apps/worker/src/alarms.ts` owns deadline scheduling. `Room` no
  longer talks to `state.storage.setAlarm` directly. The persisted
  room blob carries a `deadlines` record so deadlines survive DO
  hibernation and eviction.
- `Room.webSocketClose` and `Room.fetch` (the ws upgrade path) carry
  the disconnect/reconnect logic. The engine package is unchanged.
- `apps/web/src/screens/GameScreen.ts` renders a small banner for the
  surviving seat with a live countdown. The banner clears on
  reconnect or on `GAME_OVER`.
- The ADR-0005 invariant holds: the worker is still authoritative,
  emits the same `Snapshot + Events` shape, and the engine remains a
  pure reducer. The forfeit transition is a host-side state assembly,
  not a rule.
- Disconnects during `pre-game` and `game-over` schedule no deadline.
  A seat that closes the tab on the game-over screen does not
  retroactively become the durak.

## Alternatives revisited

- **Option 1 (instant forfeit):** rejected because mobile tab
  switches, Wi-Fi handoffs, and laptop sleep cycles all close the WS
  briefly. Any reasonable game UX needs a small reconnect window.
- **Option 2 (pause forever):** rejected because it strands the
  remaining player. They can leave the tab, but the game state never
  resolves and the durak is never declared.
- **Engine-level `FORFEIT` action:** rejected. Forfeit is a host
  concern (the host detects the disconnect); the engine should not
  carry an action that only ever fires from network state.
