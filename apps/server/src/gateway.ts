import {
  type ClientMessage,
  parseClientMessage,
  type RoomStateMessage,
  type ServerMessage,
} from "@durak/protocol";
import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { RawData, WebSocket } from "ws";
import { ZodError } from "zod";
import { stubSnapshotMessage } from "./engine-stub.js";
import type { Room, SeatIndex } from "./rooms/Room.js";
import type { RoomRegistry } from "./rooms/RoomRegistry.js";
import { SessionMap } from "./session.js";

interface JoinParams {
  roomId: string;
}

interface JoinQuery {
  token?: string;
}

export interface Gateway {
  send(roomId: string, seat: SeatIndex, msg: ServerMessage): void;
}

function sendMessage(socket: WebSocket, msg: ServerMessage): void {
  socket.send(JSON.stringify(msg));
}

function closeWithError(socket: WebSocket, code: string, message: string): void {
  sendMessage(socket, { type: "Error", code, message });
  socket.close();
}

function parseFailureMessage(err: unknown): string {
  if (err instanceof SyntaxError) return "invalid JSON";
  if (err instanceof ZodError) return err.issues[0]?.message ?? "invalid message";
  return "invalid message";
}

export async function registerGateway(
  app: FastifyInstance,
  registry: RoomRegistry,
): Promise<Gateway> {
  await app.register(websocket);
  const sessions = new SessionMap();

  function broadcastRoomState(room: Room): void {
    const seats = room.publicSeats();
    for (let i = 0; i < seats.length; i++) {
      const idx = i as SeatIndex;
      const client = room.clientForSeat(idx);
      if (!client) continue;
      const msg: RoomStateMessage = {
        type: "RoomState",
        roomId: room.id,
        seats,
        you: idx,
      };
      client.send(JSON.stringify(msg));
    }
  }

  function send(roomId: string, seat: SeatIndex, msg: ServerMessage): void {
    const room = registry.get(roomId);
    room?.clientForSeat(seat)?.send(JSON.stringify(msg));
  }

  app.get<{ Params: JoinParams; Querystring: JoinQuery }>(
    "/ws/:roomId",
    { websocket: true },
    (socket, req) => {
      const { roomId } = req.params;
      const { token } = req.query;

      const room = registry.get(roomId);
      if (!room) {
        app.log.warn({ roomId }, "ws: unknown room");
        closeWithError(socket, "ROOM_NOT_FOUND", "unknown room");
        return;
      }
      if (typeof token !== "string" || token.length === 0) {
        app.log.warn({ roomId }, "ws: missing token");
        closeWithError(socket, "BAD_TOKEN", "missing token");
        return;
      }
      const seat = room.seatForToken(token);
      if (seat === undefined) {
        app.log.warn({ roomId }, "ws: bad token");
        closeWithError(socket, "BAD_TOKEN", "invalid token for this room");
        return;
      }

      room.attachClient(seat, {
        send: (payload: string) => socket.send(payload),
        close: () => socket.close(),
      });
      sessions.bind(socket, { roomId, seat });
      app.log.info({ roomId, seat }, "ws: joined");
      broadcastRoomState(room);

      socket.on("message", (raw: RawData) => {
        let msg: ClientMessage;
        try {
          msg = parseClientMessage(JSON.parse(raw.toString()));
        } catch (err) {
          app.log.warn({ roomId, seat, err: String(err) }, "ws: parse failure");
          closeWithError(socket, "BAD_MESSAGE", parseFailureMessage(err));
          return;
        }

        switch (msg.type) {
          case "JoinRoom":
            app.log.info({ roomId, seat, name: msg.name }, "ws: join-room");
            broadcastRoomState(room);
            break;
          case "LeaveRoom":
            app.log.info({ roomId, seat }, "ws: leave-room");
            socket.close();
            break;
          case "SubmitAction":
            app.log.info({ roomId, seat, action: msg.action.type }, "ws: action");
            sendMessage(socket, stubSnapshotMessage(seat));
            break;
          case "RequestRematch":
            app.log.info({ roomId, seat }, "ws: rematch");
            sendMessage(socket, {
              type: "Error",
              code: "NOT_IMPLEMENTED",
              message: "rematch not yet implemented",
            });
            break;
        }
      });

      socket.on("close", () => {
        const session = sessions.unbind(socket);
        if (!session) return;
        const r = registry.get(session.roomId);
        if (r) {
          r.detachClient(session.seat);
          broadcastRoomState(r);
        }
        app.log.info({ roomId: session.roomId, seat: session.seat }, "ws: closed");
      });
    },
  );

  return { send };
}
