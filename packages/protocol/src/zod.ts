import type { Action } from "@durak/engine";
import { z } from "zod";
import type { ClientMessage, JoinRoom, LeaveRoom, RequestRematch, SubmitAction } from "./client";

const actionSchema = z.discriminatedUnion("type", [z.object({ type: z.literal("START_GAME") })]);

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
