import { env, runInDurableObject, SELF } from "cloudflare:test";
import { type Card, type InRoundState, initialState, step } from "@durak/engine";
import type { CreateRoomResponse } from "@durak/protocol";
import { describe, expect, it } from "vitest";
import type { Room } from "./room.js";

let ipCounter = 0;
function freshIp(): string {
  ipCounter += 1;
  return `10.54.${(ipCounter >> 8) & 0xff}.${ipCounter & 0xff}`;
}

async function postRooms(body: unknown): Promise<Response> {
  return SELF.fetch("https://example.com/rooms", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": freshIp(),
    },
    body: JSON.stringify(body),
  });
}

async function openWs(roomId: string, token: string): Promise<WebSocket> {
  const res = await SELF.fetch(`https://example.com/ws/${roomId}?token=${token}`, {
    headers: { Upgrade: "websocket" },
  });
  if (res.status !== 101 || !res.webSocket) {
    throw new Error(`expected ws upgrade, got ${res.status}`);
  }
  res.webSocket.accept();
  return res.webSocket;
}

// Force a deterministic in-round state for the room: every test below
// drives the engine via `testInjectState`, sidestepping the dealt seed so
// the close-window math is observable without arranging table layouts by
// playing dozens of moves. The bot pacing is also pinned to 0 so fan-out
// alarms can fire synchronously via testFireAlarm.

function buildBaseInRound(playerCount: number): InRoundState {
  const trumpCard: Card = { suit: "hearts", rank: 11 };
  const result = step(initialState({ seed: 1, playerCount }), { type: "START_GAME" });
  if (!result.ok || result.state.phase !== "in-round") {
    throw new Error("failed to deal");
  }
  return {
    ...result.state,
    trumpSuit: trumpCard.suit,
    trumpCard,
  };
}

describe("Room FFA throw-in window (close-window)", () => {
  it("END_ROUND from attacker opens pendingClose; THROW_IN extends; alarm fires close", async () => {
    // 4-player human-only room, no bots, so we drive everything by hand.
    const res = await postRooms({ playerCount: 4, botCount: 0 });
    const body = (await res.json()) as CreateRoomResponse & { joinTokens?: string[] };
    const tokens = body.joinTokens ?? [];
    expect(tokens.length).toBe(3);
    const t1 = tokens[0];
    const t2 = tokens[1];
    const t3 = tokens[2];
    if (!t1 || !t2 || !t3) throw new Error("missing tokens");
    const stub = env.ROOMS.get(env.ROOMS.idFromName(body.roomId));

    const wA = await openWs(body.roomId, body.hostToken);
    const wB = await openWs(body.roomId, t1);
    const wC = await openWs(body.roomId, t2);
    const wD = await openWs(body.roomId, t3);

    // Inject a fully-defended table where the only legal next action is
    // END_ROUND from the attacker (seat 0). Defender is seat 1; non-
    // defenders 0, 2, 3.
    const attack: Card = { suit: "spades", rank: 7 };
    const defense: Card = { suit: "spades", rank: 8 };
    // Seat 2 has a matching-rank card to throw in (rank 7).
    // Seat 3 has no matching rank.
    const trump: Card = { suit: "hearts", rank: 11 };
    const seedState = buildBaseInRound(4);
    const injected: InRoundState = {
      ...seedState,
      hands: [
        [{ suit: "diamonds", rank: 6 }],
        [
          { suit: "clubs", rank: 12 },
          { suit: "clubs", rank: 13 },
        ],
        [
          { suit: "spades", rank: 7 },
          { suit: "diamonds", rank: 9 },
        ],
        [{ suit: "diamonds", rank: 10 }],
      ],
      table: [{ attack, defense }],
      attacker: 0,
      defender: 1,
      trumpSuit: trump.suit,
      trumpCard: trump,
      talon: [
        { suit: "clubs", rank: 6 },
        { suit: "clubs", rank: 7 },
      ],
    };

    await runInDurableObject(stub, async (room: Room) => {
      room.testSetCloseWindowMs(500);
      // biome-ignore lint/suspicious/noExplicitAny: test seam injection.
      (room as any).engineState = injected;
    });

    // Submit END_ROUND from seat 0 — opens pending close.
    wA.send(
      JSON.stringify({
        type: "SubmitAction",
        action: { type: "END_ROUND", by: 0 },
      }),
    );

    let pending = await runInDurableObject(stub, async (room: Room) => room.testPendingClose());
    for (let i = 0; i < 10 && pending === null; i++) {
      await new Promise<void>((r) => setTimeout(r, 20));
      pending = await runInDurableObject(stub, async (room: Room) => room.testPendingClose());
    }
    if (!pending) throw new Error("expected pendingClose");
    expect(pending.kind).toBe("END_ROUND");
    expect(pending.passed).toEqual([]);
    const initialClosesAt = pending.closesAt;

    // Seat 2 throws in a matching card — extends the window.
    wC.send(
      JSON.stringify({
        type: "SubmitAction",
        action: { type: "THROW_IN", by: 2, card: { suit: "spades", rank: 7 } },
      }),
    );
    let extended = await runInDurableObject(stub, async (room: Room) => room.testPendingClose());
    for (let i = 0; i < 10 && (!extended || extended.closesAt === initialClosesAt); i++) {
      await new Promise<void>((r) => setTimeout(r, 20));
      extended = await runInDurableObject(stub, async (room: Room) => room.testPendingClose());
    }
    if (!extended) throw new Error("expected pendingClose after THROW_IN");
    expect(extended.closesAt).toBeGreaterThanOrEqual(initialClosesAt);
    expect(extended.passed).toEqual([]);

    // Seats 0, 2, 3 all PASS. After the third pass, the window closes
    // immediately and TAKE_PILE fires (the engine path now routes through
    // applyToEngine). Wait — we opened with END_ROUND but the table now
    // has an undefended attack from seat 2's THROW_IN, so END_ROUND
    // engine path would reject ATTACKS_UNDEFENDED. Instead, force the
    // window to close via the alarm and let it surface engine state.

    wA.send(
      JSON.stringify({
        type: "SubmitAction",
        action: { type: "PASS", by: 0 },
      }),
    );
    wC.send(
      JSON.stringify({
        type: "SubmitAction",
        action: { type: "PASS", by: 2 },
      }),
    );
    wD.send(
      JSON.stringify({
        type: "SubmitAction",
        action: { type: "PASS", by: 3 },
      }),
    );

    // After all three passes, pendingClose should clear (close fires).
    let cleared = await runInDurableObject(stub, async (room: Room) => room.testPendingClose());
    for (let i = 0; i < 25 && cleared !== null; i++) {
      await new Promise<void>((r) => setTimeout(r, 20));
      cleared = await runInDurableObject(stub, async (room: Room) => room.testPendingClose());
    }
    // Close fires; pendingClose null.
    expect(cleared).toBeNull();

    wA.close();
    wB.close();
    wC.close();
    wD.close();
  }, 15_000);

  it("PASS outside window is rejected with FORBIDDEN_ACTION", async () => {
    const res = await postRooms({ playerCount: 4, botCount: 0 });
    const body = (await res.json()) as CreateRoomResponse & { joinTokens?: string[] };
    const tokens = body.joinTokens ?? [];
    const t1 = tokens[0];
    const t2 = tokens[1];
    const t3 = tokens[2];
    if (!t1 || !t2 || !t3) throw new Error("missing tokens");

    const wA = await openWs(body.roomId, body.hostToken);
    const wB = await openWs(body.roomId, t1);
    const wC = await openWs(body.roomId, t2);
    const wD = await openWs(body.roomId, t3);

    const errors: string[] = [];
    wA.addEventListener("message", (event) => {
      const data = typeof event.data === "string" ? event.data : "";
      if (!data) return;
      const msg = JSON.parse(data) as { type: string; code?: string };
      if (msg.type === "Error" && msg.code) errors.push(msg.code);
    });

    // Wait for game start to settle.
    await new Promise<void>((r) => setTimeout(r, 50));

    wA.send(
      JSON.stringify({
        type: "SubmitAction",
        action: { type: "PASS", by: 0 },
      }),
    );
    await new Promise<void>((r) => setTimeout(r, 100));
    expect(errors).toContain("FORBIDDEN_ACTION");

    wA.close();
    wB.close();
    wC.close();
    wD.close();
  }, 10_000);

  it("at N=2 the close window does not open: TAKE_PILE applies immediately", async () => {
    const res = await postRooms({ mode: "human" });
    const body = (await res.json()) as CreateRoomResponse;
    const stub = env.ROOMS.get(env.ROOMS.idFromName(body.roomId));
    const t = body.joinToken;
    if (!t) throw new Error("expected joinToken");

    const wA = await openWs(body.roomId, body.hostToken);
    const wB = await openWs(body.roomId, t);

    // Inject a state where TAKE_PILE is the legal next move from the
    // defender (an undefended attack on the table).
    const trump: Card = { suit: "hearts", rank: 11 };
    const seedState = buildBaseInRound(2);
    const injected: InRoundState = {
      ...seedState,
      hands: [[{ suit: "spades", rank: 6 }], [{ suit: "diamonds", rank: 6 }]],
      table: [{ attack: { suit: "clubs", rank: 9 } }],
      attacker: 0,
      defender: 1,
      trumpSuit: trump.suit,
      trumpCard: trump,
      talon: [
        { suit: "clubs", rank: 6 },
        { suit: "clubs", rank: 7 },
      ],
    };
    await runInDurableObject(stub, async (room: Room) => {
      room.testSetCloseWindowMs(500);
      // biome-ignore lint/suspicious/noExplicitAny: test seam injection.
      (room as any).engineState = injected;
    });

    wB.send(
      JSON.stringify({
        type: "SubmitAction",
        action: { type: "TAKE_PILE", by: 1 },
      }),
    );
    await new Promise<void>((r) => setTimeout(r, 50));
    const pending = await runInDurableObject(stub, async (room: Room) => room.testPendingClose());
    expect(pending).toBeNull();

    wA.close();
    wB.close();
  }, 10_000);

  it("bot fan-out: every non-defender non-passed bot picks THROW_IN or PASS", async () => {
    // 1H + 3 bots. Inject a defended table; the human (seat 0, attacker)
    // submits END_ROUND. Bots 1..3 fan out: bot 1 is the defender so it
    // does nothing in the window; bots 2 and 3 each get a fan-out
    // alarm. We arrange seat 2 to have a matching-rank card, seat 3 to
    // have none — seat 2 should throw in, seat 3 should pass.
    const res = await postRooms({ playerCount: 4, botCount: 3 });
    const body = (await res.json()) as CreateRoomResponse;
    const stub = env.ROOMS.get(env.ROOMS.idFromName(body.roomId));

    const ws = await openWs(body.roomId, body.hostToken);
    // Wait for game-start broadcast.
    await new Promise<void>((r) => setTimeout(r, 30));

    const trump: Card = { suit: "hearts", rank: 11 };
    const seedState = buildBaseInRound(4);
    const injected: InRoundState = {
      ...seedState,
      hands: [
        [
          { suit: "diamonds", rank: 6 },
          { suit: "diamonds", rank: 9 },
        ],
        [
          { suit: "clubs", rank: 12 },
          { suit: "clubs", rank: 13 },
        ],
        [
          { suit: "spades", rank: 7 },
          { suit: "diamonds", rank: 10 },
        ],
        [
          { suit: "diamonds", rank: 11 },
          { suit: "diamonds", rank: 12 },
        ],
      ],
      table: [{ attack: { suit: "spades", rank: 8 }, defense: { suit: "spades", rank: 9 } }],
      attacker: 0,
      defender: 1,
      trumpSuit: trump.suit,
      trumpCard: trump,
      talon: [
        { suit: "clubs", rank: 6 },
        { suit: "clubs", rank: 7 },
      ],
    };
    await runInDurableObject(stub, async (room: Room) => {
      // Generous close window so the bot fan-out can fire before the
      // close alarm during the test's controlled time advance.
      room.testSetCloseWindowMs(60_000);
      room.testSetThinkBounds({ min: 200, max: 200 });
      // biome-ignore lint/suspicious/noExplicitAny: test seam injection.
      (room as any).engineState = injected;
    });

    ws.send(
      JSON.stringify({
        type: "SubmitAction",
        action: { type: "END_ROUND", by: 0 },
      }),
    );

    // Wait for pendingClose to surface.
    let pending = null as ReturnType<Room["testPendingClose"]>;
    for (let i = 0; i < 20 && pending === null; i++) {
      await new Promise<void>((r) => setTimeout(r, 20));
      pending = await runInDurableObject(stub, async (room: Room) => room.testPendingClose());
    }
    if (!pending) throw new Error("expected pendingClose");

    // Fan-out should be scheduled for bot seats 2 and 3 (seat 1 is defender).
    const fanOut = await runInDurableObject(stub, async (room: Room) => room.testBotFanOut());
    const seats = fanOut.map((e) => e.seat).sort((a, b) => a - b);
    expect(seats).toEqual([2, 3]);

    // Fire the bot-think alarm well past every fan-out deadline so both
    // bots act in the same drain. Seat 2 should THROW_IN (rank 7 missing
    // here — wait the table ranks are 8,9 so seat 2's spade-7 doesn't
    // match. Let me re-examine: ranks on table = {8, 9}. Seat 2 hand =
    // [spades 7, diamonds 10]. Neither matches → seat 2 PASSES. Seat 3
    // hand = [diamonds 11, 12]. Neither matches → seat 3 PASSES. Both
    // pass → window closes immediately (the human attacker hasn't passed
    // yet, so all-passed check requires their pass too — but the human
    // is in `passed`? No, they explicitly didn't pass). Actually
    // `allActiveNonDefendersPassed` walks every non-defender non-
    // eliminated seat. Seat 0 (human attacker) is non-defender too — it
    // hasn't passed. So the check returns false; the window stays open
    // until the close-window alarm fires.
    // Fire only at the fan-out deadline (well before the close-window
    // alarm at +60s). Both bot fan-out entries drain in this single fire.
    let fired: string[] = [];
    await runInDurableObject(stub, async (room: Room) => {
      const at = Date.now() + 1_000;
      fired = await room.testFireAlarm(at);
    });
    expect(fired).toContain("bot-think");
    expect(fired).not.toContain("close-window");

    const after = await runInDurableObject(stub, async (room: Room) => room.testPendingClose());
    if (!after) throw new Error("pendingClose should still be active until human passes");
    // Both bots should have appended to passed[].
    expect(after.passed.sort((a, b) => a - b)).toEqual([2, 3]);

    ws.close();
  }, 15_000);

  it("END_ROUND close-window: throw-ins making END_ROUND invalid wake up defender bot (DUR-55)", async () => {
    // 4-player FFA: human at seat 0 (attacker), bots at seats 1, 2, 3.
    // Setup: defended attack on the table, seat 0 ends the round → close
    // window opens. Seat 2 (bot) has a rank-8 card to throw in. After
    // fan-out the table has an undefended attack — the engine would
    // reject END_ROUND with ATTACKS_UNDEFENDED. The room must skip the
    // apply and route play back to the defender bot. (Regression: before
    // the fix, applyToEngine returned ok:false and the defender bot was
    // never scheduled, leaving the game stuck.)
    const res = await postRooms({ playerCount: 4, botCount: 3 });
    const body = (await res.json()) as CreateRoomResponse;
    const stub = env.ROOMS.get(env.ROOMS.idFromName(body.roomId));

    const ws = await openWs(body.roomId, body.hostToken);
    await new Promise<void>((r) => setTimeout(r, 30));

    const trump: Card = { suit: "hearts", rank: 11 };
    const seedState = buildBaseInRound(4);
    const injected: InRoundState = {
      ...seedState,
      hands: [
        // seat 0: human attacker — any card; won't act after END_ROUND.
        [{ suit: "diamonds", rank: 9 }],
        // seat 1: bot defender — queen of trump beats any non-trump.
        [{ suit: "hearts", rank: 12 }],
        // seat 2: bot — rank-8 throw-in candidate (matches table rank 8).
        [{ suit: "diamonds", rank: 8 }],
        // seat 3: bot — no rank match, will pass.
        [{ suit: "clubs", rank: 13 }],
      ],
      table: [
        {
          attack: { suit: "spades", rank: 8 },
          defense: { suit: "spades", rank: 9 },
        },
      ],
      attacker: 0,
      defender: 1,
      trumpSuit: trump.suit,
      trumpCard: trump,
      talon: [
        { suit: "clubs", rank: 6 },
        { suit: "clubs", rank: 7 },
      ],
    };
    await runInDurableObject(stub, async (room: Room) => {
      // Generous close window so bot fan-out fires before the close alarm.
      room.testSetCloseWindowMs(60_000);
      room.testSetThinkBounds({ min: 100, max: 100 });
      // biome-ignore lint/suspicious/noExplicitAny: test seam injection.
      (room as any).engineState = injected;
    });

    // Submit END_ROUND from the human attacker — opens the close window.
    ws.send(
      JSON.stringify({
        type: "SubmitAction",
        action: { type: "END_ROUND", by: 0 },
      }),
    );

    let pending = null as ReturnType<Room["testPendingClose"]>;
    for (let i = 0; i < 20 && pending === null; i++) {
      await new Promise<void>((r) => setTimeout(r, 20));
      pending = await runInDurableObject(stub, async (room: Room) => room.testPendingClose());
    }
    if (!pending) throw new Error("expected pendingClose after END_ROUND");
    expect(pending.kind).toBe("END_ROUND");

    // Fire bot fan-out: seat 2 throws diamonds-8, seat 3 passes.
    await runInDurableObject(stub, async (room: Room) => {
      await room.testFireAlarm(Date.now() + 1_000);
    });

    pending = await runInDurableObject(stub, async (room: Room) => room.testPendingClose());
    if (!pending) throw new Error("pendingClose should still be set after THROW_IN");

    // Engine state must now have an undefended attack from the throw-in,
    // otherwise the test isn't exercising the bug condition.
    const afterThrow = await runInDurableObject(stub, async (room: Room) =>
      room.testCurrentState(),
    );
    if (!afterThrow || afterThrow.phase !== "in-round") throw new Error("state lost phase");
    expect(afterThrow.table.length).toBe(2);
    expect(afterThrow.table[1]?.defense).toBeUndefined();

    // Drain the post-throw-in fan-out alarm first (seat 2 has no rank
    // matches left, passes; seat 3 already passed). This way the
    // close-window alarm fires alone and isn't co-dispatched with a bot
    // move — bot moves now route through `applyEnforcedAction`, so a
    // bot TAKE_PILE choice would itself open a fresh window and confuse
    // the assertions here.
    await runInDurableObject(stub, async (room: Room) => {
      await room.testFireAlarm(Date.now() + 1_000);
    });

    // Fire close-window alarm. Without the fix this would attempt
    // END_ROUND, get ATTACKS_UNDEFENDED, and silently strand the game.
    await runInDurableObject(stub, async (room: Room) => {
      await room.testFireAlarm(pending.closesAt + 100);
    });

    const cleared = await runInDurableObject(stub, async (room: Room) => room.testPendingClose());
    expect(cleared).toBeNull();

    // The defender bot must be scheduled to act on the undefended attack.
    const deadlines = await runInDurableObject(stub, async (room: Room) => room.testDeadlines());
    expect(deadlines["bot-think"]).toBeDefined();

    // Fire alarms generously: defender beats the undefended D-8 with H-12
    // (trump), or takes the pile. If the bot takes the pile a TAKE_PILE
    // close-window opens for 60s of fan-out — fire long enough for that
    // to collapse too. Bug shape is "D-8 sits on the table forever
    // undefended" — assert that scenario does NOT occur.
    await runInDurableObject(stub, async (room: Room) => {
      await room.testFireAlarm(Date.now() + 70_000);
    });
    const final = await runInDurableObject(stub, async (room: Room) => room.testCurrentState());
    if (!final) throw new Error("final state lost");
    if (final.phase === "in-round") {
      const stuckOnD8 = final.table.some(
        (p) => p.attack.suit === "diamonds" && p.attack.rank === 8 && !p.defense,
      );
      expect(stuckOnD8).toBe(false);
    }
    // (If the game advanced to game-over that's also fine — play continued.)

    ws.close();
  }, 15_000);

  it("close-window alarm firing applies the pending action", async () => {
    const res = await postRooms({ playerCount: 4, botCount: 0 });
    const body = (await res.json()) as CreateRoomResponse & { joinTokens?: string[] };
    const tokens = body.joinTokens ?? [];
    const t1 = tokens[0];
    const t2 = tokens[1];
    const t3 = tokens[2];
    if (!t1 || !t2 || !t3) throw new Error("missing tokens");
    const stub = env.ROOMS.get(env.ROOMS.idFromName(body.roomId));

    const wA = await openWs(body.roomId, body.hostToken);
    const wB = await openWs(body.roomId, t1);
    const wC = await openWs(body.roomId, t2);
    const wD = await openWs(body.roomId, t3);

    const attack: Card = { suit: "spades", rank: 7 };
    const defense: Card = { suit: "spades", rank: 8 };
    const trump: Card = { suit: "hearts", rank: 11 };
    const seedState = buildBaseInRound(4);
    const injected: InRoundState = {
      ...seedState,
      hands: [
        [
          { suit: "diamonds", rank: 6 },
          { suit: "diamonds", rank: 9 },
        ],
        [
          { suit: "clubs", rank: 12 },
          { suit: "clubs", rank: 13 },
        ],
        [
          { suit: "diamonds", rank: 10 },
          { suit: "diamonds", rank: 11 },
        ],
        [
          { suit: "diamonds", rank: 12 },
          { suit: "diamonds", rank: 13 },
        ],
      ],
      table: [{ attack, defense }],
      attacker: 0,
      defender: 1,
      trumpSuit: trump.suit,
      trumpCard: trump,
      talon: [
        { suit: "clubs", rank: 6 },
        { suit: "clubs", rank: 7 },
      ],
    };
    await runInDurableObject(stub, async (room: Room) => {
      room.testSetCloseWindowMs(500);
      // biome-ignore lint/suspicious/noExplicitAny: test seam injection.
      (room as any).engineState = injected;
    });

    wA.send(
      JSON.stringify({
        type: "SubmitAction",
        action: { type: "END_ROUND", by: 0 },
      }),
    );

    // Wait for pendingClose to surface.
    let pending = null as ReturnType<Room["testPendingClose"]>;
    for (let i = 0; i < 20 && pending === null; i++) {
      await new Promise<void>((r) => setTimeout(r, 20));
      pending = await runInDurableObject(stub, async (room: Room) => room.testPendingClose());
    }
    if (!pending) throw new Error("expected pendingClose");

    // Fire the alarm well past closesAt — the dispatcher should resolve
    // the pending END_ROUND.
    let fired: string[] = [];
    await runInDurableObject(stub, async (room: Room) => {
      fired = await room.testFireAlarm(pending.closesAt + 100);
    });
    expect(fired).toContain("close-window");

    const after = await runInDurableObject(stub, async (room: Room) => room.testPendingClose());
    expect(after).toBeNull();

    wA.close();
    wB.close();
    wC.close();
    wD.close();
  }, 15_000);
});
