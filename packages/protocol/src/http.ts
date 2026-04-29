import { z } from "zod";

export interface CreateRoomRequest {
  mode: "human" | "bot";
}

export interface CreateRoomResponse {
  roomId: string;
  hostToken: string;
  joinToken?: string | undefined;
}

export const createRoomRequestSchema = z.object({
  mode: z.enum(["human", "bot"]),
});

export const createRoomResponseSchema = z.object({
  roomId: z.string().min(1),
  hostToken: z.string().min(1),
  joinToken: z.string().min(1).optional(),
});

export function parseCreateRoomRequest(raw: unknown): CreateRoomRequest {
  return createRoomRequestSchema.parse(raw);
}

export function parseCreateRoomResponse(raw: unknown): CreateRoomResponse {
  // Cast: zod widens optional fields to `T | undefined`, which collides with
  // exactOptionalPropertyTypes. Runtime shape is verified by the schema.
  return createRoomResponseSchema.parse(raw) as CreateRoomResponse;
}

type AssertEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : never;
const _createRoomRequestParity: AssertEqual<
  z.infer<typeof createRoomRequestSchema>,
  CreateRoomRequest
> = true;
void _createRoomRequestParity;
