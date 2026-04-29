import type { Action } from "@durak/engine";

export interface JoinRoom {
  type: "JoinRoom";
  roomId: string;
  name: string;
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

export type ClientMessage = JoinRoom | LeaveRoom | SubmitAction | RequestRematch;
