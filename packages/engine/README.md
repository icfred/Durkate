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

- `State` = `PreDealState | InRoundState | GameOverState`, discriminated by
  `phase`. `InRoundState` carries `hands`, `talon`, `trumpSuit`,
  `trumpCard`, `table`, `attacker`, `defender`, `discard`, plus serialized
  `rng`. `TablePair` = attack + optional defense.
- `trumpSuit` is the locked-in trump suit for the game and is always
  defined. `trumpCard` is the visible trump card kept under the talon;
  it becomes `null` once drawn during replenishment. Use `trumpSuit` for
  `beats` checks.
- `InitOpts { seed, playerCount? }`; `initialState(opts) -> PreDealState`.
  Default `playerCount` is 2. Supported range is `2..6` inclusive
  (Podkidnoy FFA, see ADR-0010). At `N=6` the deck is exactly
  exhausted: the last-dealt card defines the trump suit and stays in
  the last seat's hand, so `trumpCard` is `null` from the start. At
  every other `N`, `trumpCard` is the visible card kept under the
  talon.
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
- `Event`: `PILE_TAKEN { by, cards, attacker, defender }`,
  `ROUND_ENDED { discarded, attacker, defender }`. The post-rotation
  `attacker`/`defender` ride the event so callers don't need to derive
  them.

Talon replenishment, timeouts, and game-over (DUR-9):

- After every `END_ROUND` and `TAKE_PILE` transition the engine refills
  hands to 6 from the talon (Podkidnoy order: previous attacker first,
  then the rest of the table in seat order, previous defender last).
  Empty seats emit no `TALON_DRAWN` event.
- `trumpCard` is the last drawable card. It is consumed only when
  `talon` is otherwise empty; once drawn, `trumpCard` becomes `null`.
  `trumpSuit` persists.
- `TIMEOUT { by }` is a server-emitted synthetic action issued when the
  active turn timer expires. It delegates: `by === defender` runs
  `TAKE_PILE` (defender forfeits the bout); `by === attacker` runs
  `END_ROUND` (attacker forfeits the right to throw in more). Any seat
  outside the active two rejects with `TIMEOUT_NOT_ACTIVE_SEAT`. Any
  underlying rejection (`TABLE_EMPTY`, `ATTACKS_UNDEFENDED`) is
  surfaced unchanged - the server is responsible for arming the timer
  only on the seat that is allowed to act.
- Game-over fires after replenishment when both `talon` and `trumpCard`
  are exhausted. If exactly one seat still holds cards, that seat is
  the durak. If every seat is empty (every player ran out on the same
  transition) the game is a draw and `durak` is `null`.
- `GameOverState` keeps `hands`, `trumpSuit`, `trumpCard`, `discard`,
  `rng`, `playerCount`, and adds `durak: number | null`. No further
  actions are accepted (`WRONG_PHASE`).
- New events: `TALON_DRAWN { by, cards }` (one per replenishing seat,
  in draw order) and `GAME_OVER { durak }` (always last in the events
  list of the transition that ends the game).

N-player FFA rules (DUR-51, see ADR-0010):

- Supported player counts: `2..6`. Throw-in: any non-defender. Rotation
  on `END_ROUND`: prev defender becomes attacker (defender role +1).
  On `TAKE_PILE`: prev defender skipped (defender role +2). Both
  rotations skip eliminated seats.
- Eliminate-as-they-empty: when a seat's hand goes to zero AND the
  talon and trump card are exhausted, the engine emits a single
  `PLAYER_OUT { seat }` event from the action that crosses the
  threshold (any of `ATTACK`, `DEFEND`, `THROW_IN`, `END_ROUND`,
  `TAKE_PILE`). Eliminated seats stay at zero cards and are skipped on
  every subsequent rotation.
- `GAME_OVER { durak }` still fires last when only one seat (or zero,
  for a draw) holds cards.

Bot (DUR-10, DUR-48):

- `bot.choose(state, opts?: { difficulty?: "easy" | "medium" | "hard" }) -> Action`.
  Pure observer: never reads or mutates `state.rng`, never reads the
  wall clock. Throws if `state.phase` is not `"in-round"`. Default
  difficulty is `"medium"` (matches the original heuristic).
- Imported as a namespace: `import { bot } from "@durak/engine";` then
  `bot.choose(state, { difficulty: "hard" })`.

**Medium** (default): the original DUR-10 heuristic.

- Open attack (table empty): cheapest card. "Cheapest" = lowest non-
  trump rank first, trumps last; ties break by suit index in `SUITS`.
- Defend: cheapest card that beats — lowest same-suit beat first,
  lowest trump only when no same-suit beat exists.
- Take pile when no card beats, or when the only beat would burn a
  trump of rank Q+ on a non-trump attack of rank 8 or lower
  (burn-trump guard).
- Throw-in (table fully covered): cheapest hand card whose rank is on
  the table, subject to engine constraints (defender has >= 1 card,
  bout cap of 6 attacks).
- End round when no legal throw-in is available.

**Easy**: noisier, burns trumps freely, no burn-trump guard.

- Open attack: random legal card weighted toward higher non-trumps
  (weight = `rank - 5`); falls back to cheapest trump only if no non-
  trump exists. Randomness uses an RNG forked from `state.rng` so it's
  deterministic per state without mutating the source.
- Defend: cheapest beat (no medium-style burn guard — happily spends
  a Q+ trump on a low non-trump).
- Throw-in: same weighted random as attack.
- Take pile only when no legal beat exists.

**Hard**: hoards trumps, never folds when defendable, light card-
counting on attack.

- Open attack: cheapest non-trump by default. With talon empty, switches
  to a "safe high" non-trump — rank >= 12 with no higher same-suit card
  unseen (counted across own hand + table + discard + visible trump
  card), forcing opponent to burn a trump or take the pile. As a final
  squeeze when talon is empty and opponent has <= 2 cards, plays the
  highest non-trump outright.
- Defend: prefer the lowest same-suit beat; only burn a trump (lowest
  available) when no same-suit beat exists.
- Take pile only when no legal defense exists — never to save a high
  trump (no burn guard).
- Throw-in: same pressure logic as attack.

All three variants are deterministic given `state.rng` and pure
observers. `bot.choose` for any difficulty never returns an illegal
action; this is enforced by a property test of self-play across many
seeds (`difficulty.test.ts`).

**Win-rate guarantees** (1000 fixed-seed 1v1 self-play matches):

| Matchup | Hard win rate (lower bound) |
|---|---|
| Hard vs Easy | > 60% |
| Hard vs Medium | > 52% |

The hard-vs-medium gap is narrower than the original target (>55%) by
design: the spec forbids hard from accepting a take-pile to save a
high trump, which is itself a strong strategic move that medium uses.
The 52% floor is the conservative regression bar; current
implementation runs at ~54%.

Forthcoming (later tickets):

- `validate(state, action) -> Result`

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
- ADR-0010: N-player FFA rules
