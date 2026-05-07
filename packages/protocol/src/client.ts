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

export type ClientMessage = JoinRoom | LeaveRoom | SubmitAction | RequestRematch | StartGame;
