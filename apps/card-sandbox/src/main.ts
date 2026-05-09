import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";

import { loadSkinAssets } from "@durak/skins-spike";
import { color, typography } from "@durak/ui";
import { Application, Container } from "pixi.js";
import { AnimSandboxScreen } from "./screens/AnimSandboxScreen.js";
import { HelpModal } from "./screens/HelpModal.js";
import { SkinSandboxScreen } from "./screens/SkinSandboxScreen.js";
import { SkinTunerScreen } from "./screens/SkinTunerScreen.js";
import type { Screen } from "./screens/types.js";

type ScreenName = "skins" | "tuner" | "anims";

const SCREEN_NAMES: readonly ScreenName[] = ["skins", "tuner", "anims"];

function isScreenName(s: string | null): s is ScreenName {
  return s !== null && (SCREEN_NAMES as readonly string[]).includes(s);
}

function activeScreen(): ScreenName {
  const raw = new URLSearchParams(window.location.search).get("screen");
  return isScreenName(raw) ? raw : "skins";
}

function navigateTo(screen: ScreenName, code?: string): void {
  const params = new URLSearchParams(window.location.search);
  params.set("screen", screen);
  if (code !== undefined) params.set("code", code);
  else params.delete("code");
  window.location.search = `?${params.toString()}`;
}

const mountId = "app";
const mount = document.getElementById(mountId);
if (!mount) throw new Error(`#${mountId} not found in index.html`);

await loadFonts();

const app = new Application();
await app.init({
  background: color.bg,
  resizeTo: mount,
  antialias: false,
  autoDensity: true,
  resolution: window.devicePixelRatio || 1,
});
mount.appendChild(app.canvas);

const screenContainer = new Container();
app.stage.addChild(screenContainer);

const modalContainer = new Container();
modalContainer.visible = false;
app.stage.addChild(modalContainer);

let activeModal: HelpModal | null = null;
function openHelpModal(): void {
  if (activeModal) return;
  activeModal = new HelpModal({ onClose: closeHelpModal });
  modalContainer.addChild(activeModal);
  modalContainer.visible = true;
  activeModal.layout(app.screen.width, app.screen.height);
}
function closeHelpModal(): void {
  if (!activeModal) return;
  activeModal.dispose();
  modalContainer.removeChild(activeModal);
  activeModal.destroy({ children: true });
  activeModal = null;
  modalContainer.visible = false;
}

const screen = activeScreen();
const mounted: Screen = await mountScreen(screen);
screenContainer.addChild(mounted);

// Top-level ESC: close modal first, otherwise return to the skins grid
// from tuner / anims. Skins itself ignores ESC at this layer (the screen
// handles ESC internally to clear ripple focus).
window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (activeModal) {
    event.preventDefault();
    closeHelpModal();
    return;
  }
  if (screen !== "skins") {
    event.preventDefault();
    navigateTo("skins");
  }
});

app.renderer.on("resize", layoutAll);
layoutAll();

function layoutAll(): void {
  const w = app.screen.width;
  const h = app.screen.height;
  mounted.layout(w, h);
  if (activeModal) activeModal.layout(w, h);
}

async function mountScreen(name: ScreenName): Promise<Screen> {
  if (name === "anims") {
    return new AnimSandboxScreen({ ticker: app.ticker });
  }
  // Both `skins` and `tuner` need the procedural skin assets; load once.
  const assets = await loadSkinAssets(app.renderer);
  if (name === "skins") {
    return new SkinSandboxScreen({
      assets,
      ticker: app.ticker,
      onShowHelp: () => openHelpModal(),
      onOpenTuner: (code) => navigateTo("tuner", code),
    });
  }
  const code = new URLSearchParams(window.location.search).get("code") ?? undefined;
  return new SkinTunerScreen({
    assets,
    ticker: app.ticker,
    canvas: app.canvas,
    ...(code !== undefined && { initialCode: code }),
  });
}

async function loadFonts(): Promise<void> {
  const family = "JetBrains Mono";
  const faces = [
    `${typography.weight.regular} ${typography.size.md}px "${family}"`,
    `${typography.weight.bold} ${typography.size.md}px "${family}"`,
  ];
  try {
    await Promise.all(faces.map((face) => document.fonts.load(face)));
  } catch (err) {
    console.warn(`[card-sandbox] font load failed for ${family}, using fallback`, err);
  }
}
