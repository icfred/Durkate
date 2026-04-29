import type { Container } from "pixi.js";
import { appStore } from "../store.js";
import { type SfxName, sfxClips } from "./sfx.js";

export type { SfxName } from "./sfx.js";

interface AudioContextCtor {
  new (): AudioContext;
}

let context: AudioContext | undefined;
let master: GainNode | undefined;
let unlockHandlerInstalled = false;

function getAudioContextCtor(): AudioContextCtor | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as Window & {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext;
}

function ensureContext(): AudioContext | undefined {
  if (context) {
    if (context.state === "suspended") {
      void context.resume();
    }
    return context;
  }
  const Ctor = getAudioContextCtor();
  if (!Ctor) return undefined;
  try {
    context = new Ctor();
    master = context.createGain();
    master.gain.value = 0.6;
    master.connect(context.destination);
  } catch {
    context = undefined;
    master = undefined;
    return undefined;
  }
  return context;
}

export function playSfx(name: SfxName): boolean {
  if (appStore.getState().audio.muted) return false;
  const ctx = ensureContext();
  if (!ctx || !master) return false;
  try {
    sfxClips[name](ctx, master, ctx.currentTime);
    return true;
  } catch {
    return false;
  }
}

export function installAudioGestureUnlock(): void {
  if (unlockHandlerInstalled) return;
  if (typeof window === "undefined") return;
  unlockHandlerInstalled = true;
  const handler = (): void => {
    ensureContext();
  };
  window.addEventListener("pointerdown", handler, { once: true });
  window.addEventListener("keydown", handler, { once: true });
}

export function attachButtonHover(button: Container): void {
  button.on("pointerover", () => {
    playSfx("buttonHover");
  });
}

export function withClickSound(handler: () => void): () => void {
  return () => {
    playSfx("buttonClick");
    handler();
  };
}

export function bindMuteShortcut(): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: KeyboardEvent): void => {
    if (event.key !== "m" && event.key !== "M") return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      return;
    }
    event.preventDefault();
    appStore.getState().toggleMute();
    playSfx("buttonClick");
  };
  window.addEventListener("keydown", handler);
  return () => window.removeEventListener("keydown", handler);
}

export function __resetAudioForTests(): void {
  if (context) {
    void context.close().catch(() => {});
  }
  context = undefined;
  master = undefined;
  unlockHandlerInstalled = false;
}
