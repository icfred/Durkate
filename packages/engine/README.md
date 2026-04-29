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
- **Step**: `step(state, action) -> StepResult`. The single transition
  function. Success carries the next state and emitted events; player-
  side illegal actions produce a typed rejection.
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
- `step(state, action) -> StepResult`. `StepResult` is a discriminated
  union: `{ ok: true, state, events } | { ok: false, reason }`.
  Player-side illegal actions return a typed `RejectReason`; system-level
  invariant violations on `START_GAME` (wrong phase, deck overflow) still
  throw.
- `START_GAME` shuffles the deck, deals `6 * playerCount` cards, reveals
  the bottom card as trump (kept separate from `talon`), and chooses the
  attacker as the player holding the lowest trump (player 0 if no
  trumps).

Bout actions (DUR-7):

- `ATTACK { by, card }` - opens a bout from the empty table. Only the
  current attacker may play. Rejected if the defender has zero cards.
- `THROW_IN { by, card }` - extra attack into an in-progress bout.
  `card.rank` must match a rank already on the table (attack or
  defense). Capped at 6 attacks per bout. Defender must have enough
  cards to keep covering. Defender may not throw in.
- `DEFEND { by, card, target }` - defender plays `card` onto
  `table[target].attack`. The Russian beat rule: same suit and higher
  rank, OR any trump beats any non-trump, OR a higher trump beats a
  lower trump.
- `Event`: `GAME_STARTED { trump, attacker }`,
  `CARD_PLAYED { by, role, card, target? }` where `role` is
  `"ATTACK" | "DEFEND" | "THROW_IN"`.
- `beats(defense, attack, trump) -> boolean` is exported for use by
  callers (bot, UI hints).

Round transitions (DUR-8):

- `TAKE_PILE { by }` - defender surrenders the round and takes every
  table card (attacks and defenses) into hand. The table clears, the
  defender is skipped on rotation: the next attacker is the player
  after the defender (in 1v1 the previous attacker keeps attacking).
- `END_ROUND { by }` - attacker declares the bout finished. Requires
  every table pair to be defended; rejects with `ATTACKS_UNDEFENDED`
  otherwise. The table cards move into `discard` and roles rotate one
  seat (old defender becomes new attacker).
- Talon replenishment is intentionally not part of this transition; it
  ships in DUR-9 alongside game-end detection.
- `Event`: `PILE_TAKEN { by, cards, attacker, defender }`,
  `ROUND_ENDED { discarded, attacker, defender }`. The post-rotation
  `attacker`/`defender` ride the event so callers don't need to derive
  them.

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
