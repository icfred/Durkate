# ADR-0007: Hosting on Cloudflare Workers + Durable Objects, Firebase Hosting for the static client

**Status:** Accepted
**Date:** 2026-04-29
**Supersedes:** the Fly.io + Cloudflare Pages choice that landed alongside DUR-31.

## Context

The MVP is browser-based 1v1 Durak — pixel-art client, websocket gateway,
server-authoritative engine. Hosting needs to satisfy:

- A long-lived ws connection per match.
- One coherent state owner per match (the engine + bot driver + turn timer).
- A static-bundle host for the Vite-built Pixi client.
- Single-developer cost target around \$5/mo. Anti-goal: idle infra burning
  the budget while no one is playing.
- No accounts, no DB, no payment processing in scope (per `docs/project_mvp.md`
  and ADR-0005).

DUR-31 sketched Fly.io for the server and Cloudflare Pages for the web. That
choice was provisional — a notebook plan from before this repo always
preferred Cloudflare Workers + Durable Objects + Firebase Hosting, and the
notebook plan is the user's intent of record. This ADR backfills the
decision.

## Options considered

### Server

1. **Fly.io always-on machine (DUR-31).** Single Node Fastify process, ws
   pinned to one box. Pros: familiar, easy to operate. Cons:
   `min_machines_running = 0` means cold starts on first connect, and `= 1`
   means paying for an idle VM; concurrency is a single event loop; no
   natural per-match isolation.

2. **Cloud Run (via Firebase App Hosting).** Container behind a load
   balancer. Pros: Firebase ecosystem fit. Cons: ws over Cloud Run is
   awkward (60-min hard cap, no sticky routing without extra glue), and
   we'd still need a per-match coordinator on top.

3. **Cloudflare Workers + Durable Objects.** One DO instance per match.
   The DO holds the engine `State`, the bot driver, the rate-limit bucket,
   the per-seat client list, and the turn timer. Pros: each match is a
   single-threaded persistent actor — exactly the shape the existing
   `Room` already had; native ws support via the Hibernation API; DO Alarms
   replace `setTimeout` for turn timers; no warm idle cost. Cons: requires
   the Workers Paid plan (\~$5/mo) for DOs.

### Static client

1. **Cloudflare Pages (DUR-31).** Pros: under the same Cloudflare account
   as the worker. Cons: just another static-host product among many.

2. **Firebase Hosting.** Pros: one of the user's existing Firebase projects
   (`durak-icfred`); free tier covers the MVP; a clean way to keep the
   web on the Firebase product family if/when accounts and Firestore are
   reactivated post-MVP. Cons: cross-vendor split (CF for ws, Firebase for
   static).

## Decision

- **Server:** Cloudflare Workers + Durable Objects, one DO per match. The
  worker fetch handler routes `POST /rooms` and `GET /ws/:roomId` to the
  named DO via `idFromName(roomId)`. The `Room` DO uses the WebSocket
  Hibernation API (`state.acceptWebSocket`) so it can sleep between
  messages without dropping connected clients, and DO Alarms
  (`state.storage.setAlarm`) for the turn timer.
- **Static client:** Firebase Hosting on the `durak-icfred` Firebase
  project. Hosting URL: `durak-icfred.web.app`. Worker URL:
  `durak-server.icfred.workers.dev`. Both default platform domains; no
  custom domain in MVP.
- **Cost target:** \~\$5/mo Workers Paid + Firebase Hosting free tier.

## Consequences

- The engine, bot, protocol, and UI packages are unchanged. Only the I/O
  shell at the top of the server flips from Fastify to Worker + DO. Tests
  for `redactFor`, `TokenBucket`, the engine, and the protocol port over
  unchanged.
- DO state survives hibernation: room mode, seats, tokens, and engine
  state are persisted to `state.storage` after every change. Per-WS
  metadata (seat) lives in `ws.serializeAttachment` so the seat survives
  wake-ups.
- Turn timer is one-at-a-time per DO (DO Alarms allow only one alarm per
  instance). The current design already used a single timer, so this is a
  drop-in replacement.
- Per-IP rate-limit on `POST /rooms` lives in module-scope Worker memory
  (best-effort; Workers may swap isolates).
- CI deploys to two targets on push to `main`: `wrangler deploy` for the
  worker and `firebase deploy --only hosting` (via the official action)
  for the web. Either failing is observable separately.
- `Room` state across hibernation is persisted; reconnect-mid-game is not
  yet supported. The disconnect-forfeit ticket will choose the policy.
- Firebase Auth, Firestore, accounts, and economy stay out of scope —
  they remain post-MVP per `docs/project_mvp.md`.

## Rejected alternatives

- **Fly.io + Pages (DUR-31).** Idle-cost vs. cold-start tradeoff and no
  natural per-match coordination. Replaced by this ADR.
- **Cloud Run via Firebase App Hosting.** Long-lived ws is awkward; the
  per-match coordinator is something we'd build anyway, and DOs are that
  building block by default.
- **All-in on Cloudflare (Workers + Pages).** Workable, but the user
  prefers Firebase Hosting for the static surface to keep the door open
  for Firebase Auth/Firestore later without re-platforming the client.
- **Custom domain.** Out of scope for MVP; revisit when the public URL
  becomes a marketing surface.
