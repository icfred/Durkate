import { Room } from "./Room.js";

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();

  create(): Room {
    let room = new Room();
    while (this.rooms.has(room.id)) room = new Room();
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
