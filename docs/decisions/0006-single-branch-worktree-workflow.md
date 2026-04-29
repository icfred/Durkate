# ADR-0006: Single-branch workflow with worktree PRs and squash-merge

**Status:** Accepted
**Date:** 2026-04-29

## Context

Solo developer, manual CLI deploys, AI agents working in worktrees on
Linear-ticketed work. Need a workflow that gives a self-review checkpoint
without ceremony, keeps git history readable, and matches the
agent-per-ticket pattern.

## Options considered

1. **No PRs, push to main** - lowest friction. CI runs on main. No moment
   to review the agent's diff before it lands.
2. **PRs to a `staging` or `develop` branch, periodically merged to main** -
   buffers main. Adds branch overhead with no payoff because deploys are
   manual; main is already the buffer.
3. **PRs to main, squash-merge** - one Linear ticket per PR, one commit per
   PR on main. Self-review checkpoint without extra branches.
4. **Stacked PRs** - chain dependent PRs. Useful when one feature is too big
   to review in one shot. Adds rebase complexity. Reach for it only when a
   ticket grows too big.

## Decision

- One long-lived branch: `main`.
- Each Linear ticket: agent worktree off `main`, branch named
  `dur-<NN>-<slug>`, PR to `main`, CI runs, user reviews diff,
  **squash-merge**.
- Stacked PRs are not the default. Used only when an oversized ticket needs
  splitting and rebasing the chain is worth the cost.
- Deploys are manual via CLI from `main`.

## Consequences

- `main` history is one commit per ticket, easy to scan and revert.
- The PR is the human review gate for agent work. CI + diff review before
  merging.
- Worktrees are ephemeral; deleted after merge.
- No `staging`/`develop` to maintain.
- If oversized tickets become common, revisit and consider stacked PRs or
  smaller ticket scoping.
