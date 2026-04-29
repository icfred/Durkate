import Fastify, { type FastifyInstance } from "fastify";
import { registerGateway } from "./gateway.js";

export async function buildApp(): Promise<FastifyInstance> {
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

  await registerGateway(app);

  return app;
}
