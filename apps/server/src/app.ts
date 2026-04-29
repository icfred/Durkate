import Fastify, { type FastifyInstance } from "fastify";
import { type Gateway, registerGateway } from "./gateway.js";
import { RoomRegistry } from "./rooms/RoomRegistry.js";

export interface BuiltApp {
  app: FastifyInstance;
  registry: RoomRegistry;
  gateway: Gateway;
}

export async function buildApp(): Promise<BuiltApp> {
  const isDev = process.env.NODE_ENV !== "production";
  const app = Fastify({
    logger: isDev
      ? {
          level: "info",
          transport: {
            target: "pino-pretty",
            options: { translateTime: "SYS:HH:MM:ss.l", ignore: "pid,hostname" },
          },
        }
      : { level: "info" },
  });

  app.get("/health", async () => ({ ok: true }));

  const registry = new RoomRegistry();
  const gateway = await registerGateway(app, registry);

  return { app, registry, gateway };
}
