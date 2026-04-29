import type { WebSocket } from "ws";
import type { SeatIndex } from "./rooms/Room.js";

export interface ClientSession {
  readonly roomId: string;
  readonly seat: SeatIndex;
}

export class SessionMap {
  private readonly bySocket = new Map<WebSocket, ClientSession>();

  bind(ws: WebSocket, session: ClientSession): void {
    this.bySocket.set(ws, session);
  }

  lookup(ws: WebSocket): ClientSession | undefined {
    return this.bySocket.get(ws);
  }

  unbind(ws: WebSocket): ClientSession | undefined {
    const session = this.bySocket.get(ws);
    if (session) this.bySocket.delete(ws);
    return session;
  }

  size(): number {
    return this.bySocket.size;
  }
}
