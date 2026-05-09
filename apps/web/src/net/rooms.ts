import {
  type BotDifficulty,
  type CreateRoomResponse,
  parseCreateRoomResponse,
} from "@durak/protocol";

export interface CreateRoomOptions {
  playerCount: 2 | 3 | 4 | 5 | 6;
  botCount: number;
  /** Bot difficulty. Ignored when `botCount === 0`. */
  difficulty?: BotDifficulty | undefined;
  /**
   * Hold the room in lobby until the host sends `StartGame`. Used by
   * the FFA flow so the host can review / share before play begins.
   */
  lobbyHold?: boolean | undefined;
  /** Best-of-N rounds. Defaults to 1 (single game). Capped at 9. */
  rounds?: number | undefined;
  serverUrl: string;
  /** Test seam: replaces global fetch. */
  fetchImpl?: typeof fetch;
}

export class CreateRoomError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "CreateRoomError";
  }
}

export async function createRoom(options: CreateRoomOptions): Promise<CreateRoomResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL("/rooms", normalizeBase(options.serverUrl)).toString();
  const body: {
    playerCount: number;
    botCount: number;
    difficulty?: BotDifficulty;
    lobbyHold?: boolean;
    rounds?: number;
  } = {
    playerCount: options.playerCount,
    botCount: options.botCount,
  };
  if (options.botCount > 0 && options.difficulty !== undefined) {
    body.difficulty = options.difficulty;
  }
  if (options.lobbyHold === true) body.lobbyHold = true;
  if (options.rounds !== undefined && options.rounds > 1) body.rounds = options.rounds;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new CreateRoomError(`network: ${(err as Error).message}`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    // Friendlier message for the rate limit — the worker returns
    // `{"error":"rate limit exceeded"}` JSON which read raw was
    // accidentally surfaced to the user as the lobby "RETRY" caption.
    if (response.status === 429) {
      throw new CreateRoomError("Hit the create-room rate limit. Try again in a moment.", 429);
    }
    throw new CreateRoomError(text || response.statusText, response.status);
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch (err) {
    throw new CreateRoomError(`invalid JSON: ${(err as Error).message}`, response.status);
  }
  try {
    return parseCreateRoomResponse(json);
  } catch (err) {
    throw new CreateRoomError(`invalid response shape: ${(err as Error).message}`, response.status);
  }
}

/** Convert a websocket-style URL to an http(s) URL for fetching JSON routes. */
export function httpFromWsUrl(wsUrl: string): string {
  try {
    const url = new URL(wsUrl);
    if (url.protocol === "ws:") url.protocol = "http:";
    else if (url.protocol === "wss:") url.protocol = "https:";
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return wsUrl;
  }
}

function normalizeBase(serverUrl: string): string {
  if (serverUrl.startsWith("ws:") || serverUrl.startsWith("wss:")) {
    return httpFromWsUrl(serverUrl);
  }
  return serverUrl;
}
