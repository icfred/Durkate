# @durak/engine

## Purpose

The Durak rules engine. Pure functions, no I/O, no `Math.random()`, no
wall-clock reads. The bot lives here too. Used by `apps/server` for
authoritative validation, by `apps/web` only for type imports if needed,
and by tests directly.

## Key concepts

- **State**: a tagged-union snapshot of a game (deck, hands, table, talon,
  trump, attacker, defender, phase, seeded RNG).
- **Action**: a typed message representing a player decision or a
  server-emitted synthetic event (e.g. `TIMEOUT`).
- **Event**: a side-product of a transition describing what changed (e.g.
  `CARD_PLAYED`, `PILE_TAKEN`). Drives client animation/SFX cues.
- **Step**: `step(state, action) -> { state, events }`. The single
  transition function.
- **Bot**: deterministic given `(state, seed)`. Returns an action.

## Public API

Primitives (DUR-5):

- `Suit`, `Rank`, `Card` types; `SUITS`, `RANKS` const tuples.
- `buildDeck() -> Card[]` - 36-card Russian deck (6 through Ace, 4 suits).
- `Rng`, `RngState`; `createRng(seed: number) -> Rng`;
  `rngFromState(state: RngState) -> Rng`. xoshiro128** seeded via
  splitmix32. State is a serializable `[u32, u32, u32, u32]`.
- `shuffle<T>(items: readonly T[], rng: Rng) -> T[]` - Fisher-Yates,
  non-mutating, deterministic given the RNG.

State and step (DUR-6):

- `State` = `PreDealState | InRoundState`, discriminated by `phase`.
  `InRoundState` carries `hands`, `talon`, `trump`, `table`, `attacker`,
  `defender`, `discard`, plus serialized `rng`. `TablePair` = attack +
  optional defense.
- `InitOpts { seed, playerCount? }`; `initialState(opts) -> PreDealState`.
  Default `playerCount` is 2.
- `Action`: `{ type: "START_GAME" }` (more to come).
- `Event`: `{ type: "GAME_STARTED", trump, attacker }` (more to come).
- `step(state, action) -> StepResult` = `{ state, events }`. `START_GAME`
  shuffles the deck, deals `6 * playerCount` cards, reveals the bottom
  card as trump (kept separate from `talon`), and chooses the attacker
  as the player holding the lowest trump (player 0 if no trumps in any
  hand).

Forthcoming (later tickets):

- `validate(state, action) -> Result`
- `bot.choose(state) -> Action`

## Invariants

- No card appears in two places.
- Talon size never goes negative.
- Defender never holds more cards than the attacker.
- Same seed + same action sequence = same final state.
- Engine never reads the wall clock or generates randomness outside its
  seeded PRNG.

## Gotchas

- Hidden information (opponent hands, deck contents) lives in state on the
  server. Per-player redacted views are produced by the server, not by the
  engine.
- Bot delays for player comprehensibility live on the server, not in the
  engine. The engine has no notion of time.

## Related ADRs

- ADR-0002: hybrid engine architecture
- ADR-0003: determinism strategy
