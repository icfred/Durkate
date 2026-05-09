import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";

import { loadSkinAssets } from "@durak/skins-spike";
import { Button, color, FocusManager, spacing, typography } from "@durak/ui";
import { Application, Container, Text } from "pixi.js";
import { AnimSandboxScreen } from "./screens/AnimSandboxScreen.js";
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

function navigate(screen: ScreenName): void {
  const params = new URLSearchParams(window.location.search);
  params.set("screen", screen);
  // Drop deep-link `code` when leaving the tuner so re-entries get a clean
  // start. Tuner→tuner navigation never goes through here.
  if (screen !== "tuner") params.delete("code");
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

const NAV_HEIGHT = 56;
const TITLE = "CARD SANDBOX";

function buildNav(current: ScreenName): { container: Container; height: number } {
  const container = new Container();

  const title = new Text({
    text: TITLE,
    style: {
      fontFamily: typography.family,
      fontSize: typography.size.md,
      fontWeight: typography.weight.bold,
      fill: color.text,
      letterSpacing: typography.letterSpacing.stamp,
    },
  });
  title.x = spacing.lg;
  title.y = Math.round((NAV_HEIGHT - title.height) / 2);
  container.addChild(title);

  const focus = new FocusManager();
  const labels: Record<ScreenName, string> = {
    skins: "GRID",
    tuner: "TUNER",
    anims: "ANIMS",
  };
  let cursor = 240;
  for (const name of SCREEN_NAMES) {
    const isActive = name === current;
    const btn = new Button({
      label: isActive ? `[${labels[name]}]` : labels[name],
      width: 120,
      height: 36,
      onActivate: () => {
        if (name === current) return;
        navigate(name);
      },
    });
    btn.x = cursor;
    btn.y = Math.round((NAV_HEIGHT - 36) / 2);
    container.addChild(btn);
    focus.register(btn);
    cursor += btn.width + spacing.sm;
  }
  focus.attach();
  return { container, height: NAV_HEIGHT };
}

const screen = activeScreen();
const nav = buildNav(screen);
nav.container.y = 0;
app.stage.addChild(nav.container);

const screenContainer = new Container();
screenContainer.y = nav.height;
app.stage.addChild(screenContainer);

const mounted: Screen = await mountScreen(screen);
screenContainer.addChild(mounted);

app.renderer.on("resize", layoutAll);
layoutAll();

function layoutAll(): void {
  const w = app.screen.width;
  const h = app.screen.height;
  mounted.layout(w, Math.max(0, h - nav.height));
}

async function mountScreen(name: ScreenName): Promise<Screen> {
  if (name === "anims") {
    return new AnimSandboxScreen({ ticker: app.ticker });
  }
  // Both `skins` and `tuner` need the procedural skin assets; load once.
  const assets = await loadSkinAssets(app.renderer);
  if (name === "skins") {
    return new SkinSandboxScreen({ assets, ticker: app.ticker });
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
