import { type CreateRoomResponse, parseCreateRoomResponse } from "@durak/protocol";

export interface CreateRoomOptions {
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

export async function createRoom(
  mode: "human" | "bot",
  options: CreateRoomOptions,
): Promise<CreateRoomResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL("/rooms", normalizeBase(options.serverUrl)).toString();
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
  } catch (err) {
    throw new CreateRoomError(`network: ${(err as Error).message}`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
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
  // The web client may be configured with a websocket-style URL
  // (`VITE_WS_URL`) that points at the gateway path. For HTTP fetches
  // we want only the origin.
  if (serverUrl.startsWith("ws:") || serverUrl.startsWith("wss:")) {
    return httpFromWsUrl(serverUrl);
  }
  return serverUrl;
}
