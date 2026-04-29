import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { RawData, WebSocket } from "ws";

export async function registerGateway(app: FastifyInstance): Promise<void> {
  await app.register(websocket);

  app.get("/ws", { websocket: true }, (socket: WebSocket) => {
    app.log.info("ws: client connected");

    socket.on("message", (raw: RawData) => {
      const text = raw.toString();
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
      socket.send(JSON.stringify({ type: "ECHO", payload }));
    });

    socket.on("close", () => {
      app.log.info("ws: client disconnected");
    });
  });
}
