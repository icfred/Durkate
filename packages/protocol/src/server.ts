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

export interface RoomStateMessage {
  type: "RoomState";
  roomId: string;
  seats: RoomSeat[];
  you: SeatIndex | null;
}

export type ServerMessage = SnapshotMessage | EventsMessage | ErrorMessage | RoomStateMessage;
