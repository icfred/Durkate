import { randomBytes } from "node:crypto";

export type SeatIndex = 0 | 1;

export interface Seat {
  readonly index: SeatIndex;
  readonly name: string;
  readonly token: string;
}

export interface JoinResult {
  readonly seat: SeatIndex;
  readonly token: string;
}

export interface ClientHandle {
  send(payload: string): void;
  close(): void;
}

export class RoomFullError extends Error {
  constructor() {
    super("Room is full");
    this.name = "RoomFullError";
  }
}

const SEAT_COUNT = 2;
const TOKEN_BYTES = 32;
const ROOM_ID_BYTES = 12;

function randomBase64Url(byteLength: number): string {
  return randomBytes(byteLength).toString("base64url");
}

export class Room {
  readonly id: string;
  private readonly seats: (Seat | null)[] = new Array<Seat | null>(SEAT_COUNT).fill(null);
  private readonly clients = new Map<SeatIndex, ClientHandle>();

  constructor(id: string = randomBase64Url(ROOM_ID_BYTES)) {
    this.id = id;
  }

  addPlayer(name: string): JoinResult {
    const seat = this.seats.indexOf(null);
    if (seat === -1) throw new RoomFullError();
    const token = randomBase64Url(TOKEN_BYTES);
    const seatIndex = seat as SeatIndex;
    this.seats[seatIndex] = { index: seatIndex, name, token };
    return { seat: seatIndex, token };
  }

  removePlayer(token: string): boolean {
    const seat = this.seatForToken(token);
    if (seat === undefined) return false;
    this.seats[seat] = null;
    this.clients.delete(seat);
    return true;
  }

  seatForToken(token: string): SeatIndex | undefined {
    for (let i = 0; i < this.seats.length; i++) {
      const s = this.seats[i];
      if (s !== null && s !== undefined && s.token === token) return i as SeatIndex;
    }
    return undefined;
  }

  attachClient(seat: SeatIndex, client: ClientHandle): void {
    this.clients.set(seat, client);
  }

  detachClient(seat: SeatIndex): void {
    this.clients.delete(seat);
  }

  clientForSeat(seat: SeatIndex): ClientHandle | undefined {
    return this.clients.get(seat);
  }
}
