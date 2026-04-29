import { defineConfig } from "vite";

const SERVER_TARGET = process.env.VITE_DEV_PROXY_TARGET ?? "http://127.0.0.1:8787";

export default defineConfig({
  server: {
    port: 5173,
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
