/// <reference path="../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />

import type { Room } from "./room.js";

declare global {
  namespace Cloudflare {
    interface Env {
      ROOMS: DurableObjectNamespace<Room>;
      ALLOWED_ORIGINS: string;
      TURN_TIMEOUT_MS: string;
    }
  }
}
