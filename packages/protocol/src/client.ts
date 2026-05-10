import type { Action } from "@durak/engine";

export interface JoinRoom {
  type: "JoinRoom";
  roomId: string;
  name: string;
  mode?: "human" | "bot" | undefined;
}

export interface LeaveRoom {
  type: "LeaveRoom";
}

export interface SubmitAction {
  type: "SubmitAction";
  action: Action;
}

export interface RequestRematch {
  type: "RequestRematch";
}

/**
 * Sent by the host to release a `lobbyHold` room and begin play. The
 * server fills any remaining empty seats with bots and starts. Ignored
 * if the room is already running or wasn't held.
 */
export interface StartGame {
  type: "StartGame";
}

/**
 * Host-only. Cycle a bot seat's difficulty before play starts. Rejected
 * if the seat isn't a bot, the room isn't in the lobby phase, or the
 * sender isn't seat 0.
 */
export interface SetBotDifficulty {
  type: "SetBotDifficulty";
  seat: number;
  difficulty: "easy" | "medium" | "hard";
}

/**
 * Host-only. Mutate lobby settings in place (player count, bot count,
 * rounds, difficulty) without recreating the room. Lets joined humans
 * stay attached across host tweaks. Rejected if the room is not in
 * lobby phase, the sender is not seat 0, or the change would evict a
 * joined human (playerCount shrink below `1 + humansJoined`).
 *
 * Each field is independently optional; omit a field to leave it
 * unchanged. The server validates the combined post-change state and
 * rejects atomically (no partial application).
 */
export interface LobbySettingsChange {
  type: "LobbySettingsChange";
  playerCount?: number;
  botCount?: number;
  rounds?: number;
  difficulty?: "easy" | "medium" | "hard";
}

export type ClientMessage =
  | JoinRoom
  | LeaveRoom
  | SubmitAction
  | RequestRematch
  | StartGame
  | SetBotDifficulty
  | LobbySettingsChange;
