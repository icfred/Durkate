import { z } from "zod";

export type BotDifficulty = "easy" | "medium" | "hard";

export type CreateRoomRequest = LegacyCreateRoomRequest | NPlayerCreateRoomRequest;

export interface LegacyCreateRoomRequest {
  mode: "human" | "bot";
  /** Bot difficulty for `mode: "bot"` rooms. Ignored for human rooms. Defaults to medium. */
  difficulty?: BotDifficulty | undefined;
}

export interface NPlayerCreateRoomRequest {
  playerCount: 2 | 3 | 4 | 5 | 6;
  /** Number of bot seats. Must satisfy `0 <= botCount < playerCount`. */
  botCount: number;
  /** Difficulty applied to all bots in the room. Defaults to medium. */
  difficulty?: BotDifficulty | undefined;
  /**
   * Hold the room in lobby until the host sends `StartGame`. Bot seats
   * still get reserved (and their tokens returned in `joinTokens` so the
   * host can share to swap them out for friends), but the engine isn't
   * started until the host signals ready.
   */
  lobbyHold?: boolean | undefined;
}

export interface NormalizedCreateRoomRequest {
  playerCount: 2 | 3 | 4 | 5 | 6;
  botCount: number;
  difficulty?: BotDifficulty | undefined;
  lobbyHold?: boolean | undefined;
}

export interface CreateRoomResponse {
  roomId: string;
  hostToken: string;
  /**
   * Tokens for the remaining human seats (length = playerCount - botCount - 1).
   * Empty when the host is the only human (e.g., 1v3-bot).
   */
  joinTokens: string[];
  /**
   * Legacy alias populated when `joinTokens.length === 1` so the existing
   * web client (1v1 lobby flow) keeps working until it adopts the array
   * shape.
   */
  joinToken?: string | undefined;
}

export const botDifficultySchema = z.enum(["easy", "medium", "hard"]);

const playerCountSchema = z.union([
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
]);

export const legacyCreateRoomRequestSchema = z.object({
  mode: z.enum(["human", "bot"]),
  difficulty: botDifficultySchema.optional(),
});

export const nPlayerCreateRoomRequestSchema = z
  .object({
    playerCount: playerCountSchema,
    botCount: z.number().int().nonnegative(),
    difficulty: botDifficultySchema.optional(),
    lobbyHold: z.boolean().optional(),
  })
  .refine((v) => v.botCount < v.playerCount, {
    message: "botCount must be < playerCount",
    path: ["botCount"],
  });

export const createRoomRequestSchema = z.union([
  nPlayerCreateRoomRequestSchema,
  legacyCreateRoomRequestSchema,
]);

export const createRoomResponseSchema = z
  .object({
    roomId: z.string().min(1),
    hostToken: z.string().min(1),
    joinTokens: z.array(z.string().min(1)).optional(),
    joinToken: z.string().min(1).optional(),
  })
  .transform((v) => {
    // Back-compat: callers that send only `joinToken` still parse — surface
    // the canonical `joinTokens` array regardless.
    if (v.joinTokens) return v;
    if (v.joinToken !== undefined) return { ...v, joinTokens: [v.joinToken] };
    return { ...v, joinTokens: [] };
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

/**
 * Collapses both request shapes to the N-player form. Legacy `mode: "human"`
 * maps to `{ playerCount: 2, botCount: 0 }`; `mode: "bot"` maps to
 * `{ playerCount: 2, botCount: 1 }`.
 */
export function normalizeCreateRoomRequest(req: CreateRoomRequest): NormalizedCreateRoomRequest {
  if ("playerCount" in req) {
    const out: NormalizedCreateRoomRequest = {
      playerCount: req.playerCount,
      botCount: req.botCount,
    };
    if (req.difficulty !== undefined) out.difficulty = req.difficulty;
    if (req.lobbyHold !== undefined) out.lobbyHold = req.lobbyHold;
    return out;
  }
  const out: NormalizedCreateRoomRequest = {
    playerCount: 2,
    botCount: req.mode === "bot" ? 1 : 0,
  };
  if (req.difficulty !== undefined) out.difficulty = req.difficulty;
  return out;
}
