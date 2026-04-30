import { bot } from "@durak/engine";
import type { Snapshot } from "@durak/protocol";
import type { StoreApi } from "zustand/vanilla";
import type { AppState } from "../store.js";
import { isYourTurn, snapshotToBotState } from "./snapshotToBotState.js";

export interface AutoplayOptions {
  store: StoreApi<AppState>;
  /** Test seam: defaults to `bot.choose`. */
  choose?: typeof bot.choose;
}

/**
 * Subscribes to the store. While `devtools.autoplay` is on, every distinct
 * snapshot in which the local seat is the actor produces a `bot.choose`
 * call and dispatches the resulting action. Repeated identical snapshots
 * are deduped so the bot does not fire twice for the same state.
 */
export function subscribeAutoplay(options: AutoplayOptions): () => void {
  const { store } = options;
  const choose = options.choose ?? bot.choose;
  let lastDispatched: Snapshot | null = null;

  const tick = (state: AppState): void => {
    if (!state.devtools.autoplay) {
      lastDispatched = null;
      return;
    }
    const snapshot = state.snapshot;
    if (!snapshot || snapshot === lastDispatched) return;
    if (!isYourTurn(snapshot)) return;
    lastDispatched = snapshot;
    let action: ReturnType<typeof choose>;
    try {
      action = choose(snapshotToBotState(snapshot));
    } catch (err) {
      console.warn("[devtools] autoplay bot.choose threw", err);
      return;
    }
    state.submitAction(action);
  };

  tick(store.getState());
  return store.subscribe(tick);
}
