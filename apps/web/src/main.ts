import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";

import type { BotDifficulty } from "@durak/protocol";
import { loadSkinAssets } from "@durak/skins-spike";
import { color, typography } from "@durak/ui";
import { Application } from "pixi.js";
import { bindMuteShortcut, installAudioGestureUnlock } from "./audio/index.js";
import { bindDevtoolsShortcut, DevPanel, subscribeAutoplay } from "./devtools/index.js";
import { gameOverFixture } from "./fixtures/gameOverFixtures.js";
import { createConnectionController } from "./net/connection.js";
import { CreateRoomError, createRoom, httpFromWsUrl } from "./net/rooms.js";
import { AnimSandboxScreen } from "./sandbox/anims/AnimSandboxScreen.js";
import { SfxSandboxScreen } from "./sandbox/sfx/SfxSandboxScreen.js";
import { SkinSandboxScreen } from "./sandbox/skins/SkinSandboxScreen.js";
import { SkinTunerScreen } from "./sandbox/skins/SkinTunerScreen.js";
import { ScreenRouter } from "./screenRouter.js";
import { GameOverScreen } from "./screens/GameOverScreen.js";
import { GameScreen } from "./screens/GameScreen.js";
import { LobbyScreen } from "./screens/LobbyScreen.js";
import { type GameSetupConfig, MainMenuScreen } from "./screens/MainMenuScreen.js";
import { type FixtureName, isFixtureName, loadFixture } from "./screens/sandboxFixtures.js";
import type { Screen } from "./screens/types.js";
import {
  type AppState,
  appStore,
  buildShareUrl,
  type GameOverData,
  type Mode,
  parseHashJoin,
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
  // Load skin assets at runtime via the procedural generator. The pre-baked
  // atlas in /public/skins/ was built around the old bitmap-only patterns
  // and can't represent the procedural ones; we'll re-introduce a bake step
  // later if startup cost ever matters.
  const skinAssets = await loadSkinAssets(app.renderer);
  const tunerInitialCode = new URLSearchParams(window.location.search).get("code") ?? undefined;
  const screen =
    sandboxParam === "skins"
      ? new SkinSandboxScreen({ assets: skinAssets, ticker: app.ticker })
      : new SkinTunerScreen({
          assets: skinAssets,
          ticker: app.ticker,
          canvas: app.canvas,
          ...(tunerInitialCode !== undefined && { initialCode: tunerInitialCode }),
        });
  screen.layout(app.screen.width, app.screen.height);
  app.stage.addChild(screen);
  app.renderer.on("resize", () => {
    screen.layout(app.screen.width, app.screen.height);
  });
  installAudioGestureUnlock();
} else if (sandboxParam === "anims") {
  const screen = new AnimSandboxScreen({ ticker: app.ticker });
  screen.layout(app.screen.width, app.screen.height);
  app.stage.addChild(screen);
  app.renderer.on("resize", () => {
    screen.layout(app.screen.width, app.screen.height);
  });
} else if (sandboxParam === "sfx") {
  const screen = new SfxSandboxScreen();
  screen.layout(app.screen.width, app.screen.height);
  app.stage.addChild(screen);
  app.renderer.on("resize", () => {
    screen.layout(app.screen.width, app.screen.height);
  });
  installAudioGestureUnlock();
  bindMuteShortcut();
} else {
  applyBootRouting();

  const wsUrl = resolveWsUrl();
  const httpUrl = resolveHttpServerUrl(wsUrl);

  // Single entry — every room goes through the unified ffa+lobbyHold
  // path so the lobby is the only setup surface. The host can adjust
  // player count, rounds, and per-bot difficulty in the lobby itself
  // and start when ready. Non-host seats default to bots; humans
  // joining via the invite link swap into a bot's seat.
  const startGame = (config: GameSetupConfig) => {
    const payload: RoomCreationStart = {
      mode: "ffa",
      playerCount: config.playerCount,
      botCount: config.botCount,
      lobbyHold: true,
    };
    if (config.botCount > 0) payload.difficulty = config.difficulty;
    if (config.rounds > 1) payload.rounds = config.rounds;
    void runRoomCreation(payload, httpUrl);
  };

  // Lobby cycle debounce. Each PLAYERS/ROUNDS click updates the
  // pending values immediately (subscribers fan out so the lobby
  // labels refresh without a screen rebuild) and schedules a single
  // `startGame` ~300ms after the last click. Without this, every
  // click fires its own `POST /rooms` and the worker's 10/min/IP
  // bucket trips after a handful of cycles.
  let pendingPlayers: number | null = null;
  let pendingRounds: number | null = null;
  let cycleTimer: ReturnType<typeof setTimeout> | null = null;
  const pendingListeners = new Set<
    (next: { players: number | null; rounds: number | null }) => void
  >();
  const notifyPending = () => {
    const snap = { players: pendingPlayers, rounds: pendingRounds };
    for (const l of pendingListeners) l(snap);
  };
  const scheduleCycleFlush = () => {
    if (cycleTimer !== null) clearTimeout(cycleTimer);
    cycleTimer = setTimeout(() => {
      cycleTimer = null;
      const s = appStore.getState();
      const players = pendingPlayers ?? s.playerCount ?? 2;
      const rounds = pendingRounds ?? s.room?.match?.totalRounds ?? 3;
      pendingPlayers = null;
      pendingRounds = null;
      notifyPending();
      startGame({
        playerCount: players as 2 | 3 | 4 | 5 | 6,
        botCount: Math.max(0, players - 1),
        difficulty: "medium",
        rounds,
      });
    }, 300);
  };

  const router = new ScreenRouter({
    stage: app.stage,
    build(state: AppState): Screen {
      switch (state.phase) {
        case "menu":
          return new MainMenuScreen({
            onStart: startGame,
          });
        case "lobby": {
          const mode = state.mode ?? "ffa";
          const roomCode = state.roomCode ?? "";
          const playerCount = state.playerCount ?? 2;
          const botCount = state.botCount ?? Math.max(0, playerCount - 1);
          const tokens = state.joinTokens;
          const shareTokens =
            tokens.length > 0 ? tokens : state.shareToken ? [state.shareToken] : [];
          const shareUrls = shareTokens.map((token) =>
            buildShareUrl(window.location.origin, roomCode, token, {
              playerCount,
              botCount,
            }),
          );
          const totalRounds = state.room?.match?.totalRounds ?? 1;
          const focusHint = state.lobbyFocusHint;
          const lobbyOpts: ConstructorParameters<typeof LobbyScreen>[0] = {
            mode,
            roomCode,
            playerCount,
            botCount,
            rounds: totalRounds,
            shareUrls,
            initialRoom: state.room,
            initialCreation: state.roomCreation,
            subscribe: (listener) =>
              appStore.subscribe((next, prev) => {
                if (next.room !== prev.room) listener(next.room);
              }),
            subscribeCreation: (listener) =>
              appStore.subscribe((next, prev) => {
                if (next.roomCreation !== prev.roomCreation) listener(next.roomCreation);
              }),
            onRetry: () => retryRoomCreation(state, httpUrl),
            onJoin: (next) => {
              appStore.getState().showLobby({ mode, roomCode: next });
            },
            onBack: () => appStore.getState().showMenu(),
            ...(focusHint ? { initialFocus: focusHint } : {}),
          };
          // Always-on START NOW: every room created from PLAY is
          // ffa+lobbyHold so the host explicitly releases the hold.
          // Joiners (entering via invite link) hit this branch too,
          // but their StartGame is rejected server-side (host-only).
          lobbyOpts.onStart = () => appStore.getState().startGame();
          // Per-bot difficulty cycle. Reads the freshest difficulty from
          // the store at click time and rotates easy → medium → hard.
          lobbyOpts.onCycleBotDifficulty = (seatIndex: number) => {
            const seat = appStore.getState().room?.seats[seatIndex];
            const current = seat?.difficulty ?? "medium";
            const order = ["easy", "medium", "hard"] as const;
            const next = order[(order.indexOf(current) + 1) % order.length] ?? "medium";
            appStore.getState().setBotDifficulty(seatIndex, next);
          };
          // Player-count and rounds cycles. Each click updates the
          // pending value immediately (so the lobby label flips
          // instantly), then a debounced timer fires the actual
          // `startGame` once the user pauses — coalescing rapid arrow
          // spam into a single `POST /rooms` so we don't trip the
          // worker rate limiter.
          lobbyOpts.onCyclePlayers = (dir) => {
            const s = appStore.getState();
            const cur = pendingPlayers ?? s.playerCount ?? 2;
            const order = [2, 3, 4, 5, 6];
            const idx = order.indexOf(cur);
            const nextIdx = ((idx === -1 ? 0 : idx) + dir + order.length) % order.length;
            pendingPlayers = order[nextIdx] ?? 2;
            s.setLobbyFocusHint("players");
            notifyPending();
            scheduleCycleFlush();
          };
          lobbyOpts.onCycleRounds = (dir) => {
            const s = appStore.getState();
            const cur = pendingRounds ?? s.room?.match?.totalRounds ?? 3;
            const order = [3, 5, 7];
            const idx = order.indexOf(cur);
            const nextIdx = ((idx === -1 ? 0 : idx) + dir + order.length) % order.length;
            pendingRounds = order[nextIdx] ?? 3;
            s.setLobbyFocusHint("rounds");
            notifyPending();
            scheduleCycleFlush();
          };
          lobbyOpts.pendingPlayers = pendingPlayers;
          lobbyOpts.pendingRounds = pendingRounds;
          lobbyOpts.subscribePending = (listener) => {
            pendingListeners.add(listener);
            return () => {
              pendingListeners.delete(listener);
            };
          };
          return new LobbyScreen(lobbyOpts);
        }
        case "game":
          return new GameScreen({
            snapshot: state.snapshot,
            submitAction: (action) => appStore.getState().submitAction(action),
            initialRoom: state.room,
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
            subscribeRoom: (listener) =>
              appStore.subscribe((next, prev) => {
                if (next.room !== prev.room) listener(next.room);
              }),
          });
        case "gameover":
          return new GameOverScreen({
            data: state.gameover ?? { youSeat: 0, durak: null },
            match: state.room?.match ?? null,
            initialRematch: deriveRematchStatus(state),
            subscribeRematch: (listener) =>
              appStore.subscribe((next, prev) => {
                if (next.room === prev.room) return;
                listener(deriveRematchStatus(next));
              }),
            onRematch: () => appStore.getState().requestRematch(),
            // Mid-match next-round button: piggyback on the existing
            // StartGame ws action, which the worker now treats as
            // "advance the match" when the game has just ended.
            onNextRound: () => appStore.getState().startGame(),
            onMainMenu: () => appStore.getState().showMenu(),
          });
      }
    },
  });

  router.setView(app.screen.width, app.screen.height);
  router.start();

  const connection = createConnectionController({ store: appStore, serverUrl: wsUrl });
  connection.start();

  installAudioGestureUnlock();
  bindMuteShortcut();

  const devPanel = new DevPanel({
    store: appStore,
    forceDisconnect: () => connection.forceDisconnect(),
  });
  devPanel.layout(app.screen.width, app.screen.height);
  app.stage.addChild(devPanel);
  devPanel.attach();
  bindDevtoolsShortcut({ store: appStore });
  subscribeAutoplay({ store: appStore });

  app.renderer.on("resize", () => {
    router.setView(app.screen.width, app.screen.height);
    devPanel.layout(app.screen.width, app.screen.height);
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
  const join = parseHashJoin(window.location.hash);
  if (join) {
    const payload: { roomCode: string; token: string; playerCount?: number; botCount?: number } = {
      roomCode: join.roomCode,
      token: join.token,
    };
    if (join.playerCount !== undefined) payload.playerCount = join.playerCount;
    if (join.botCount !== undefined) payload.botCount = join.botCount;
    appStore.getState().enterLobbyAsJoiner(payload);
  }
}

interface RoomCreationStart {
  mode: Mode;
  playerCount: 2 | 3 | 4 | 5 | 6;
  botCount: number;
  difficulty?: BotDifficulty;
  lobbyHold?: boolean;
  rounds?: number;
}

async function runRoomCreation(start: RoomCreationStart, httpUrl: string): Promise<void> {
  const beginPayload: {
    mode: Mode;
    playerCount: number;
    botCount: number;
    difficulty?: BotDifficulty;
  } = {
    mode: start.mode,
    playerCount: start.playerCount,
    botCount: start.botCount,
  };
  if (start.difficulty !== undefined) beginPayload.difficulty = start.difficulty;
  appStore.getState().beginRoomCreation(beginPayload);
  const createOptions: Parameters<typeof createRoom>[0] = {
    serverUrl: httpUrl,
    playerCount: start.playerCount,
    botCount: start.botCount,
  };
  if (start.difficulty !== undefined) createOptions.difficulty = start.difficulty;
  if (start.lobbyHold === true) createOptions.lobbyHold = true;
  if (start.rounds !== undefined) createOptions.rounds = start.rounds;
  try {
    const response = await createRoom(createOptions);
    appStore.getState().roomCreated({
      roomId: response.roomId,
      hostToken: response.hostToken,
      joinTokens: response.joinTokens,
    });
  } catch (err) {
    const message =
      err instanceof CreateRoomError ? err.message : `unexpected error: ${String(err)}`;
    appStore.getState().roomCreationFailed(message);
  }
}

function retryRoomCreation(state: AppState, httpUrl: string): void {
  const mode = state.mode ?? "friend";
  const playerCount = (state.playerCount ?? 2) as 2 | 3 | 4 | 5 | 6;
  const botCount = state.botCount ?? (mode === "bot" ? 1 : 0);
  const start: RoomCreationStart = { mode, playerCount, botCount };
  if (state.botDifficulty !== undefined) start.difficulty = state.botDifficulty;
  void runRoomCreation(start, httpUrl);
}

function resolveWsUrl(): string {
  const fromEnv = import.meta.env.VITE_WS_URL;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

function resolveHttpServerUrl(wsUrl: string): string {
  const fromEnv = import.meta.env.VITE_SERVER_URL;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  // Default: derive from VITE_WS_URL (or same-origin) so the dev Vite proxy
  // forwards both /ws and /rooms to the server without manual env setup.
  return httpFromWsUrl(wsUrl);
}

function deriveRematchStatus(state: AppState): {
  youRequested: boolean;
  opponentRequested: boolean;
} {
  const room = state.room;
  if (!room) return { youRequested: false, opponentRequested: false };
  const requested = room.rematchRequested;
  const you = room.you;
  const youRequested = you !== null && requested.includes(you);
  const opponentRequested = requested.some((seat) => seat !== you);
  return { youRequested, opponentRequested };
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
