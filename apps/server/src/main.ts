import Fastify from "fastify";
import { registerGateway } from "./gateway.js";

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? "0.0.0.0";
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

try {
  await app.listen({ port: PORT, host: HOST });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
