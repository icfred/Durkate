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
          // Bot-pacing tests opt in by overriding these via runInDurableObject;
          // the default of 0/0 keeps existing end-to-end bot games synchronous
          // so the seat-0 driver loops don't have to advance fake time.
          BOT_THINK_MIN_MS: "0",
          BOT_THINK_MAX_MS: "0",
        },
      },
    }),
  ],
});
