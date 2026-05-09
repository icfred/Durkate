import { defineConfig } from "vite";

export default defineConfig({
  server: {
    // 7474 — picked so it doesn't collide with the durak web app on 7373.
    port: 7474,
    strictPort: true,
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
