import { Room, type RoomOpts } from "./Room.js";

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();

  create(opts: RoomOpts = {}): Room {
    let room = new Room(opts);
    while (this.rooms.has(room.id)) room = new Room(opts);
    this.rooms.set(room.id, room);
    return room;
  }

  get(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  delete(id: string): boolean {
    return this.rooms.delete(id);
  }

  size(): number {
    return this.rooms.size;
  }
}
