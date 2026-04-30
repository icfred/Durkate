import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      singleWorker: true,
      // The wrangler.toml ships the production allowlist as the default.
      // Tests fetch from `https://example.com`, so override to empty here
      // (any origin reflected) — same shape `wrangler dev` gets via
      // `apps/worker/.dev.vars`.
      miniflare: {
        bindings: {
          ALLOWED_ORIGINS: "",
          // Tests dispatch many actions in tight loops — production
          // rate-limit (20/5s) would silently drop most of them. Set
          // a high ceiling so flow-of-control behavior is what's tested.
          RATE_LIMIT_CAPACITY: "10000",
        },
      },
    }),
  ],
});
