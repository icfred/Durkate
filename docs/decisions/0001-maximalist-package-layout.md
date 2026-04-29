# ADR-0001: Maximalist package layout

**Status:** Accepted
**Date:** 2026-04-29

## Context

The MVP is one client + one server + one ruleset, but the vision treats the
engine as a long-lived, reusable component (bot, server validation, future
replay, possibly other card games later). Package boundaries inside the
Turborepo monorepo set the dependency graph for everything that follows.

## Options considered

1. **Maximalist** - `apps/web`, `apps/server`, `packages/engine`,
   `packages/protocol`, `packages/ui`, `packages/assets`, plus `tools/`.
   Pro: clean isolation from day one, real boundaries where it matters
   (engine, protocol). Con: more setup, more cross-package ceremony.
2. **Pragmatic** - same as above but UI primitives stay in `apps/web` until
   extraction is justified. Less ceremony, fuzzier boundary.
3. **Minimalist** - one `packages/shared` for engine + protocol. Lowest
   overhead, blurs the engine boundary.

## Decision

Maximalist. Engine, protocol, UI kit, and assets each get their own package.
A `tools/` directory holds Python asset pipeline scripts (not a TS package).

## Consequences

- The engine, protocol, and UI kit are testable and importable in isolation.
  The bot package consumes the engine without pulling client or server.
- A second Durak variant or a second card game can ship without restructuring.
- More upfront config (per-package `tsconfig`, `package.json`, build).
- Cross-package changes require multi-package PRs, which is fine given
  squash-merge per Linear ticket.
- `tools/` is intentionally outside `packages/` because it is Python, not TS,
  and its outputs land in `packages/assets`.
