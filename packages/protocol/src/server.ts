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

export interface RoomStateMessage {
  type: "RoomState";
  roomId: string;
  seats: RoomSeat[];
  you: SeatIndex | null;
  /** Seats that have requested a rematch while in `game-over`. Empty otherwise. */
  rematchRequested: SeatIndex[];
  disconnect?: DisconnectState | null;
  /** Bot seats currently in their pre-move "thinking" delay. Empty / omitted otherwise. */
  thinkingSeats?: SeatIndex[];
}

export type ServerMessage = SnapshotMessage | EventsMessage | ErrorMessage | RoomStateMessage;
