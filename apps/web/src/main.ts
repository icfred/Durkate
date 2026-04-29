import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";

import { color, typography } from "@durak/ui";
import { Application } from "pixi.js";
import { SkinSandboxScreen } from "./sandbox/skins/SkinSandboxScreen.js";
import { ScreenRouter } from "./screenRouter.js";
import { LobbyScreen } from "./screens/LobbyScreen.js";
import { MainMenuScreen } from "./screens/MainMenuScreen.js";
import { PlaceholderScreen } from "./screens/PlaceholderScreen.js";
import type { Screen } from "./screens/types.js";
import { type AppState, appStore, generateRoomCode, parseHashRoom } from "./store.js";

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

const sandboxParam = new URLSearchParams(window.location.search).get("sandbox");
if (sandboxParam === "skins") {
  const sandbox = new SkinSandboxScreen({ renderer: app.renderer, ticker: app.ticker });
  sandbox.layout(app.screen.width, app.screen.height);
  app.stage.addChild(sandbox);
  app.renderer.on("resize", () => {
    sandbox.layout(app.screen.width, app.screen.height);
  });
} else {
  const initialRoom = parseHashRoom(window.location.hash);
  if (initialRoom) {
    appStore.getState().showLobby({ mode: "friend", roomCode: initialRoom });
  }

  const router = new ScreenRouter({
    stage: app.stage,
    build(state: AppState): Screen {
      switch (state.phase) {
        case "menu":
          return new MainMenuScreen({
            onPlay: (mode) => {
              appStore.getState().showLobby({ mode, roomCode: generateRoomCode() });
            },
          });
        case "lobby": {
          const code = state.roomCode ?? generateRoomCode();
          return new LobbyScreen({
            roomCode: code,
            shareUrl: `${window.location.origin}/#room=${code}`,
            onJoin: (next) => {
              appStore.getState().showLobby({ mode: state.mode ?? "friend", roomCode: next });
            },
          });
        }
        case "game":
        case "gameover":
          return new PlaceholderScreen(state.phase.toUpperCase());
      }
    },
  });

  router.setView(app.screen.width, app.screen.height);
  router.start();

  app.renderer.on("resize", () => {
    router.setView(app.screen.width, app.screen.height);
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
    console.warn(`[web] font load failed for ${family}, using fallback`, err);
  }
}
