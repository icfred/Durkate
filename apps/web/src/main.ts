import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";

import { loadSkinAssets } from "@durak/skins-spike";
import { color, typography } from "@durak/ui";
import { Application } from "pixi.js";
import { bindMuteShortcut, installAudioGestureUnlock } from "./audio/index.js";
import { gameOverFixture } from "./fixtures/gameOverFixtures.js";
import { createConnectionController } from "./net/connection.js";
import { SkinSandboxScreen } from "./sandbox/skins/SkinSandboxScreen.js";
import { SkinTunerScreen } from "./sandbox/skins/SkinTunerScreen.js";
import { ScreenRouter } from "./screenRouter.js";
import { GameOverScreen } from "./screens/GameOverScreen.js";
import { GameScreen } from "./screens/GameScreen.js";
import { LobbyScreen } from "./screens/LobbyScreen.js";
import { MainMenuScreen } from "./screens/MainMenuScreen.js";
import { type FixtureName, isFixtureName, loadFixture } from "./screens/sandboxFixtures.js";
import type { Screen } from "./screens/types.js";
import {
  type AppState,
  appStore,
  type GameOverData,
  generateRoomCode,
  parseHashRoom,
} from "./store.js";

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
if (sandboxParam === "skins" || sandboxParam === "skins-tuner") {
  const skinAssets = await loadSkinAssets(app.renderer, {
    imageUrl: "/skins/atlas.png",
    manifestUrl: "/skins/atlas.json",
  });
  const screen =
    sandboxParam === "skins"
      ? new SkinSandboxScreen({ assets: skinAssets, ticker: app.ticker })
      : new SkinTunerScreen({ assets: skinAssets, ticker: app.ticker });
  screen.layout(app.screen.width, app.screen.height);
  app.stage.addChild(screen);
  app.renderer.on("resize", () => {
    screen.layout(app.screen.width, app.screen.height);
  });
} else {
  applyBootRouting();

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
          const mode = state.mode ?? "friend";
          return new LobbyScreen({
            mode,
            roomCode: code,
            shareUrl: `${window.location.origin}/#room=${code}`,
            initialRoom: state.room,
            subscribe: (listener) =>
              appStore.subscribe((next, prev) => {
                if (next.room !== prev.room) listener(next.room);
              }),
            onJoin: (next) => {
              appStore.getState().showLobby({ mode, roomCode: next });
            },
          });
        }
        case "game":
          return new GameScreen({
            snapshot: state.snapshot,
            submitAction: (action) => appStore.getState().submitAction(action),
            subscribe: (listener) =>
              appStore.subscribe((next, prev) => {
                if (next.snapshot !== prev.snapshot) listener(next.snapshot);
              }),
            subscribeEvents: (listener) =>
              appStore.subscribe((next, prev) => {
                const delta = next.eventsTotal - prev.eventsTotal;
                if (delta <= 0) return;
                listener(next.events.slice(-delta));
              }),
          });
        case "gameover":
          return new GameOverScreen({
            data: state.gameover ?? { youSeat: 0, durak: null },
            onRematch: () => appStore.getState().requestRematch(),
            onMainMenu: () => appStore.getState().showMenu(),
          });
      }
    },
  });

  router.setView(app.screen.width, app.screen.height);
  router.start();

  const serverUrl = resolveWsUrl();
  const connection = createConnectionController({ store: appStore, serverUrl });
  connection.start();

  installAudioGestureUnlock();
  bindMuteShortcut();

  app.renderer.on("resize", () => {
    router.setView(app.screen.width, app.screen.height);
  });
}

function applyBootRouting(): void {
  const params = new URLSearchParams(window.location.search);
  const sandbox = params.get("sandbox");
  if (sandbox === "game") {
    const requested = params.get("fixture") ?? "fresh";
    const fixture: FixtureName = isFixtureName(requested) ? requested : "fresh";
    const snapshot = loadFixture(fixture);
    appStore.setState({ phase: "game", snapshot });
    return;
  }
  if (sandbox === "gameover") {
    const fixtureName = params.get("fixture") ?? "won";
    const data: GameOverData = gameOverFixture(fixtureName);
    appStore.getState().showGameOver(data);
    return;
  }
  const initialRoom = parseHashRoom(window.location.hash);
  if (initialRoom) {
    appStore.getState().showLobby({ mode: "friend", roomCode: initialRoom });
  }
}

function resolveWsUrl(): string {
  const fromEnv = import.meta.env.VITE_WS_URL;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
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
