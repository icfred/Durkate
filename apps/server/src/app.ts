import Fastify, { type FastifyInstance } from "fastify";
import { type Gateway, registerGateway } from "./gateway.js";
import { RoomRegistry } from "./rooms/RoomRegistry.js";

export interface BuildAppOptions {
  /**
   * Origin allowlist for ws upgrades. Empty means "allow any origin", which is
   * the dev default. Production sets this from `ALLOWED_ORIGINS` (CSV).
   */
  allowedOrigins?: readonly string[];
}

export interface BuiltApp {
  app: FastifyInstance;
  registry: RoomRegistry;
  gateway: Gateway;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<BuiltApp> {
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

  const allowedOrigins = options.allowedOrigins ?? parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
  const registry = new RoomRegistry();
  const gateway = await registerGateway(app, registry, { allowedOrigins });

  return { app, registry, gateway };
}

function parseAllowedOrigins(raw: string | undefined): readonly string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
