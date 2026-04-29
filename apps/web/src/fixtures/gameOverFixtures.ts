import type { GameOverData } from "../store.js";

export function gameOverFixture(name: string): GameOverData {
  switch (name) {
    case "won":
    case "victory":
      return { youSeat: 0, durak: 1, seatNames: ["You", "Bot"] };
    case "lost":
    case "defeat":
    case "durak":
      return { youSeat: 0, durak: 0, seatNames: ["You", "Bot"] };
    case "draw":
      return { youSeat: 0, durak: null, seatNames: ["You", "Bot"] };
    default:
      return { youSeat: 0, durak: 1, seatNames: ["You", "Bot"] };
  }
}
