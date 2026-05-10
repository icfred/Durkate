import { type Action, type Event, RANKS, SUITS } from "@durak/engine";
import { z } from "zod";
import type {
  ClientMessage,
  JoinRoom,
  LeaveRoom,
  LobbySettingsChange,
  RequestRematch,
  SubmitAction,
} from "./client";
import type { ErrorMessage, ServerMessage } from "./server";
import type { YouView } from "./snapshot";

const cardSchema = z
  .object({
    suit: z.enum(SUITS),
    rank: z.union(
      RANKS.map((r) => z.literal(r)) as [
        z.ZodLiteral<6>,
        z.ZodLiteral<7>,
        z.ZodLiteral<8>,
        z.ZodLiteral<9>,
        z.ZodLiteral<10>,
        z.ZodLiteral<11>,
        z.ZodLiteral<12>,
        z.ZodLiteral<13>,
        z.ZodLiteral<14>,
      ],
    ),
  })
  .readonly();

const seatSchema = z.number().int().nonnegative();

const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("START_GAME") }),
  z.object({ type: z.literal("ATTACK"), by: seatSchema, card: cardSchema }),
  z.object({
    type: z.literal("DEFEND"),
    by: seatSchema,
    card: cardSchema,
    target: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("THROW_IN"), by: seatSchema, card: cardSchema }),
  z.object({ type: z.literal("TAKE_PILE"), by: seatSchema }),
  z.object({ type: z.literal("END_ROUND"), by: seatSchema }),
  z.object({ type: z.literal("PASS"), by: seatSchema }),
  z.object({ type: z.literal("TIMEOUT"), by: seatSchema }),
]);

export const joinRoomSchema = z.object({
  type: z.literal("JoinRoom"),
  roomId: z.string().min(1),
  name: z.string().min(1),
  mode: z.enum(["human", "bot"]).optional(),
});

export const leaveRoomSchema = z.object({
  type: z.literal("LeaveRoom"),
});

export const submitActionSchema = z.object({
  type: z.literal("SubmitAction"),
  action: actionSchema,
});

export const requestRematchSchema = z.object({
  type: z.literal("RequestRematch"),
});

export const startGameSchema = z.object({
  type: z.literal("StartGame"),
});

export const setBotDifficultySchema = z.object({
  type: z.literal("SetBotDifficulty"),
  seat: seatSchema,
  difficulty: z.enum(["easy", "medium", "hard"]),
});

export const lobbySettingsChangeSchema = z.object({
  type: z.literal("LobbySettingsChange"),
  playerCount: z.number().int().min(2).max(6).optional(),
  botCount: z.number().int().min(0).max(5).optional(),
  rounds: z.number().int().min(1).max(9).optional(),
  difficulty: z.enum(["easy", "medium", "hard"]).optional(),
});

export const clientMessageSchema = z.discriminatedUnion("type", [
  joinRoomSchema,
  leaveRoomSchema,
  submitActionSchema,
  requestRematchSchema,
  startGameSchema,
  setBotDifficultySchema,
  lobbySettingsChangeSchema,
]);

export function parseClientMessage(raw: unknown): ClientMessage {
  // Cast: zod widens optional fields (e.g. `LobbySettingsChange.playerCount`)
  // to `T | undefined`, which collides with `exactOptionalPropertyTypes`.
  // The runtime shape is verified by `clientMessageSchema.parse`.
  return clientMessageSchema.parse(raw) as ClientMessage;
}

const tablePairSchema = z.object({
  attack: cardSchema,
  defense: cardSchema.optional(),
});

const youViewSchema = z.object({
  seat: seatSchema,
  hand: z.array(cardSchema),
});

const snapshotSchema = z.object({
  phase: z.literal("in-round"),
  playerCount: z.number().int().nonnegative(),
  handCounts: z.array(z.number().int().nonnegative()),
  talonCount: z.number().int().nonnegative(),
  trump: cardSchema.nullable(),
  trumpSuit: z.enum(SUITS),
  table: z.array(tablePairSchema),
  attacker: seatSchema,
  defender: seatSchema,
  discard: z.array(cardSchema),
  seat: seatSchema,
  you: youViewSchema,
});

const eventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("GAME_STARTED"),
    trump: cardSchema,
    attacker: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("CARD_PLAYED"),
    by: z.number().int().nonnegative(),
    role: z.enum(["ATTACK", "DEFEND", "THROW_IN"]),
    card: cardSchema,
    target: z.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal("PILE_TAKEN"),
    by: z.number().int().nonnegative(),
    cards: z.array(cardSchema),
    attacker: z.number().int().nonnegative(),
    defender: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("ROUND_ENDED"),
    discarded: z.array(cardSchema),
    attacker: z.number().int().nonnegative(),
    defender: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("TALON_DRAWN"),
    by: z.number().int().nonnegative(),
    cards: z.array(cardSchema),
  }),
  z.object({
    type: z.literal("PLAYER_OUT"),
    seat: seatSchema,
  }),
  z.object({
    type: z.literal("PLAYER_PASSED"),
    by: seatSchema,
  }),
  z.object({
    type: z.literal("GAME_OVER"),
    durak: z.number().int().nonnegative().nullable(),
  }),
]);

export const snapshotMessageSchema = z.object({
  type: z.literal("Snapshot"),
  snapshot: snapshotSchema,
});

export const eventsMessageSchema = z.object({
  type: z.literal("Events"),
  events: z.array(eventSchema),
});

export const errorMessageSchema = z.object({
  type: z.literal("Error"),
  code: z.string(),
  message: z.string(),
});

const disconnectStateSchema = z.object({
  seat: seatSchema,
  forfeitAt: z.number(),
});

const pendingCloseStateSchema = z.object({
  kind: z.enum(["END_ROUND", "TAKE_PILE"]),
  closesAt: z.number(),
  passed: z.array(seatSchema),
});

const matchStateSchema = z.object({
  currentRound: z.number().int().min(1),
  totalRounds: z.number().int().min(1),
  scores: z.array(z.number().int().nonnegative()),
  matchOver: z.boolean(),
});

export const roomStateMessageSchema = z.object({
  type: z.literal("RoomState"),
  roomId: z.string(),
  seats: z.array(
    z.object({
      name: z.string().nullable(),
      kind: z.enum(["human", "bot"]).optional(),
      difficulty: z.enum(["easy", "medium", "hard"]).optional(),
    }),
  ),
  you: seatSchema.nullable(),
  rematchRequested: z.array(seatSchema),
  disconnect: disconnectStateSchema.nullable().optional(),
  disconnects: z.array(disconnectStateSchema).optional(),
  thinkingSeats: z.array(seatSchema).optional(),
  eliminated: z.array(seatSchema).optional(),
  pendingClose: pendingCloseStateSchema.nullable().optional(),
  turnDeadline: z.number().nullable().optional(),
  match: matchStateSchema.nullable().optional(),
});

export const sessionAssignedMessageSchema = z.object({
  type: z.literal("SessionAssigned"),
  seat: seatSchema,
  token: z.string().min(1),
});

export const serverMessageSchema = z.discriminatedUnion("type", [
  snapshotMessageSchema,
  eventsMessageSchema,
  errorMessageSchema,
  roomStateMessageSchema,
  sessionAssignedMessageSchema,
]);

export function parseServerMessage(raw: unknown): ServerMessage {
  // Cast: zod's inferred output widens optional fields to `T | undefined`,
  // which collides with `exactOptionalPropertyTypes` here. The runtime
  // shape is verified by `serverMessageSchema.parse` and round-trip tests.
  return serverMessageSchema.parse(raw) as ServerMessage;
}

// Schema/type parity guards: if engine `Action` or any `ClientMessage`
// variant drifts from its Zod schema, these fail to compile. Server
// message schemas with optional fields (Event.target, TablePair.defense)
// can't use this exact-match guard under exactOptionalPropertyTypes;
// they're enforced at runtime by the round-trip tests.
type AssertEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : never;
const _actionParity: AssertEqual<z.infer<typeof actionSchema>, Action> = true;
const _joinRoomParity: AssertEqual<z.infer<typeof joinRoomSchema>, JoinRoom> = true;
const _leaveRoomParity: AssertEqual<z.infer<typeof leaveRoomSchema>, LeaveRoom> = true;
const _submitActionParity: AssertEqual<z.infer<typeof submitActionSchema>, SubmitAction> = true;
const _requestRematchParity: AssertEqual<
  z.infer<typeof requestRematchSchema>,
  RequestRematch
> = true;
// Optional fields on LobbySettingsChange defeat structural equality under
// exactOptionalPropertyTypes — same pattern as RoomState above. Discriminator
// parity is asserted via the union below; runtime round-trip tests cover
// the field shape.
const _lobbySettingsChangeTypeParity: AssertEqual<
  z.infer<typeof lobbySettingsChangeSchema>["type"],
  LobbySettingsChange["type"]
> = true;
const _clientParity: AssertEqual<
  z.infer<typeof clientMessageSchema>["type"],
  ClientMessage["type"]
> = true;
const _youViewParity: AssertEqual<z.infer<typeof youViewSchema>, YouView> = true;
const _errorMessageParity: AssertEqual<z.infer<typeof errorMessageSchema>, ErrorMessage> = true;
// `RoomStateMessage.disconnect` is optional (`disconnect?: ...`); zod's
// inferred `optional().nullable()` widens the value to include
// `undefined`. Under `exactOptionalPropertyTypes` that defeats structural
// equality. The runtime round-trip test below covers schema/type drift.
// Optional fields on Event (CARD_PLAYED.target) defeat structural equality
// under exactOptionalPropertyTypes. Asserting the discriminator union is
// exhaustive catches missing variants without tripping on optionality.
const _eventTypeParity: AssertEqual<z.infer<typeof eventSchema>["type"], Event["type"]> = true;
void _actionParity;
void _joinRoomParity;
void _leaveRoomParity;
void _submitActionParity;
void _requestRematchParity;
void _lobbySettingsChangeTypeParity;
void _clientParity;
void _youViewParity;
void _errorMessageParity;
void _eventTypeParity;
