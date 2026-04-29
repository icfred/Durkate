import { type Action, RANKS, SUITS } from "@durak/engine";
import { z } from "zod";
import type { ClientMessage, JoinRoom, LeaveRoom, RequestRematch, SubmitAction } from "./client";

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
  z.object({ type: z.literal("TIMEOUT"), by: seatSchema }),
]);

export const joinRoomSchema = z.object({
  type: z.literal("JoinRoom"),
  roomId: z.string().min(1),
  name: z.string().min(1),
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

export const clientMessageSchema = z.discriminatedUnion("type", [
  joinRoomSchema,
  leaveRoomSchema,
  submitActionSchema,
  requestRematchSchema,
]);

export function parseClientMessage(raw: unknown): ClientMessage {
  return clientMessageSchema.parse(raw);
}

// Schema/type parity guards: if engine `Action` or any `ClientMessage`
// variant drifts from its Zod schema, these fail to compile.
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
const _clientParity: AssertEqual<z.infer<typeof clientMessageSchema>, ClientMessage> = true;
void _actionParity;
void _joinRoomParity;
void _leaveRoomParity;
void _submitActionParity;
void _requestRematchParity;
void _clientParity;
