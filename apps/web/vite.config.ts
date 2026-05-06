import { defineConfig } from "vite";

const SERVER_TARGET = process.env.VITE_DEV_PROXY_TARGET ?? "http://127.0.0.1:8787";

export default defineConfig({
  server: {
    // 7373 — chosen so it doesn't collide with Vite's default (5173)
    // or the worker dev server (8787). strictPort: true so dev fails
    // loudly instead of silently sliding to the next free port.
    port: 7373,
    strictPort: true,
    proxy: {
      "/rooms": { target: SERVER_TARGET, changeOrigin: true },
      "/ws": { target: SERVER_TARGET, changeOrigin: true, ws: true },
      "/health": { target: SERVER_TARGET, changeOrigin: true },
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
