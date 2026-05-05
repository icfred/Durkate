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
}

export type ServerMessage = SnapshotMessage | EventsMessage | ErrorMessage | RoomStateMessage;
