import { buildApp } from "./app.js";

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? "0.0.0.0";

try {
  const { app } = await buildApp();
  await app.listen({ port: PORT, host: HOST });
} catch (err) {
  console.error(err);
  process.exit(1);
}
