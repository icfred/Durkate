import { z } from "zod";

export type BotDifficulty = "easy" | "medium" | "hard";

export interface CreateRoomRequest {
  mode: "human" | "bot";
  /** Bot difficulty for `mode: "bot"` rooms. Ignored for human rooms. Defaults to medium. */
  difficulty?: BotDifficulty | undefined;
}

export interface CreateRoomResponse {
  roomId: string;
  hostToken: string;
  joinToken?: string | undefined;
}

export const botDifficultySchema = z.enum(["easy", "medium", "hard"]);

export const createRoomRequestSchema = z.object({
  mode: z.enum(["human", "bot"]),
  difficulty: botDifficultySchema.optional(),
});

export const createRoomResponseSchema = z.object({
  roomId: z.string().min(1),
  hostToken: z.string().min(1),
  joinToken: z.string().min(1).optional(),
});

export function parseCreateRoomRequest(raw: unknown): CreateRoomRequest {
  // Cast: zod widens optional fields to `T | undefined`, which collides with
  // exactOptionalPropertyTypes. Runtime shape is verified by the schema.
  return createRoomRequestSchema.parse(raw) as CreateRoomRequest;
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
