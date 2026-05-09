import type { Event } from "@durak/engine";
import type { SeatIndex, Snapshot } from "./snapshot";

export interface SnapshotMessage {
  type: "Snapshot";
  snapshot: Snapshot;
}

export interface EventsMessage {
  type: "Events";
  events: Event[];
}

export interface ErrorMessage {
  type: "Error";
  code: string;
  message: string;
}

export interface RoomSeat {
  name: string | null;
  /**
   * Whether this seat is occupied by a human or a bot. Omitted on
   * legacy clients/servers that haven't adopted the per-seat shape.
   */
  kind?: "human" | "bot";
  /** Bot difficulty for `kind: "bot"` seats. Omitted otherwise. */
  difficulty?: "easy" | "medium" | "hard";
}

export interface DisconnectState {
  seat: SeatIndex;
  forfeitAt: number;
}

/**
 * Pending close-window for a round-resolving action (END_ROUND or
 * TAKE_PILE). The host has decided which transition will fire but is
 * giving every other non-defender a beat to throw in or pass first
 * (ADR-0011). Cleared once the alarm fires or every active non-defender
 * has passed.
 */
export interface PendingCloseState {
  kind: "END_ROUND" | "TAKE_PILE";
  closesAt: number;
  passed: SeatIndex[];
}

/**
 * Best-of-N match state. `currentRound` is 1-indexed and refers to the
 * round currently in play (or just completed if the match itself is
 * done). `scores[seat]` is that seat's "durak count" — the number of
 * rounds in which they ended up the durak. The match winner is the seat
 * with the lowest score (fewest losses). `totalRounds` is the cap.
 */
export interface MatchState {
  currentRound: number;
  totalRounds: number;
  scores: number[];
  /** True once the match itself is complete (winner decided). */
  matchOver: boolean;
}

export interface RoomStateMessage {
  type: "RoomState";
  roomId: string;
  seats: RoomSeat[];
  you: SeatIndex | null;
  /** Seats that have requested a rematch while in `game-over`. Empty otherwise. */
  rematchRequested: SeatIndex[];
  /**
   * Earliest pending disconnect, or null. Retained as a back-compat alias
   * for clients that haven't adopted the `disconnects` array yet.
   */
  disconnect?: DisconnectState | null;
  /** All currently disconnected seats and their forfeit deadlines. */
  disconnects?: DisconnectState[];
  /** Bot seats currently in their pre-move "thinking" delay. Empty / omitted otherwise. */
  thinkingSeats?: SeatIndex[];
  /** Seats eliminated this game (hand emptied + talon exhausted, or forfeited). */
  eliminated?: SeatIndex[];
  /** Pending round-close window (ADR-0011), null/omitted when not in window. */
  pendingClose?: PendingCloseState | null;
  /**
   * Wall-clock ms (Date.now() basis) at which the active actor's turn
   * times out. Null/omitted when no turn timer is armed (e.g. between
   * rounds, during a `pendingClose` window — the close-window timer
   * supersedes per-turn). Clients render a countdown for the active
   * seat; a server-side alarm enforces the deadline.
   */
  turnDeadline?: number | null;
  /**
   * Best-of-N match state. Omitted on legacy single-round rooms so the
   * client can fall back to its existing one-and-done flow.
   */
  match?: MatchState | null;
}

export type ServerMessage = SnapshotMessage | EventsMessage | ErrorMessage | RoomStateMessage;
