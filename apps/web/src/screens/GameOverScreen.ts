import { Button, color, FocusManager, Panel, spacing, typography } from "@durak/ui";
import { Container, Text } from "pixi.js";
import type { GameOverData } from "../store.js";
import type { Screen } from "./types.js";

const PANEL_W = 480;
const PANEL_H = 360;
const BUTTON_W = 200;
const BUTTON_H = 56;

export type Outcome = "victory" | "defeat" | "draw";

export interface GameOverScreenOptions {
  data: GameOverData;
  onRematch(): void;
  onMainMenu(): void;
}

export function classifyOutcome(data: GameOverData): Outcome {
  if (data.durak === null) return "draw";
  return data.durak === data.youSeat ? "defeat" : "victory";
}

function headlineFor(outcome: Outcome): string {
  switch (outcome) {
    case "victory":
      return "VICTORY";
    case "defeat":
      return "DURAK";
    case "draw":
      return "DRAW";
  }
}

function sublineFor(data: GameOverData, outcome: Outcome): string {
  if (outcome === "draw") return "No durak this round";
  const seat = data.durak;
  if (seat === null) return "";
  const name = data.seatNames?.[seat]?.trim();
  const who = name && name.length > 0 ? name : `Player ${seat + 1}`;
  return `${who} is the Durak`;
}

export class GameOverScreen extends Container implements Screen {
  private readonly focus = new FocusManager();
  private readonly panel: Panel;
  readonly outcome: Outcome;

  constructor(options: GameOverScreenOptions) {
    super();
    this.outcome = classifyOutcome(options.data);

    this.panel = new Panel({ width: PANEL_W, height: PANEL_H });
    this.addChild(this.panel);

    const headline = new Text({
      text: headlineFor(this.outcome),
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.xxl,
        fontWeight: typography.weight.bold,
        fill: this.outcome === "victory" ? color.accent : color.text,
        letterSpacing: typography.letterSpacing.stamp,
      },
    });
    headline.x = Math.round((PANEL_W - headline.width) / 2);
    headline.y = spacing.xl;
    this.panel.addChild(headline);

    const subline = new Text({
      text: sublineFor(options.data, this.outcome),
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.md,
        fill: color.textMuted,
        letterSpacing: typography.letterSpacing.wide,
      },
    });
    subline.x = Math.round((PANEL_W - subline.width) / 2);
    subline.y = headline.y + headline.height + spacing.md;
    this.panel.addChild(subline);

    const hint = new Text({
      text: "ARROWS MOVE  -  ENTER ACTIVATES",
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.xs,
        fill: color.textMuted,
        letterSpacing: typography.letterSpacing.wide,
      },
    });
    hint.x = Math.round((PANEL_W - hint.width) / 2);
    hint.y = subline.y + subline.height + spacing.xs;
    this.panel.addChild(hint);

    const rowGap = spacing.md;
    const rowWidth = BUTTON_W * 2 + rowGap;
    const rowX = Math.round((PANEL_W - rowWidth) / 2);
    const rowY = PANEL_H - BUTTON_H - spacing.xl;

    const rematch = new Button({
      label: "REMATCH",
      width: BUTTON_W,
      height: BUTTON_H,
      onActivate: () => options.onRematch(),
    });
    rematch.x = rowX;
    rematch.y = rowY;
    this.panel.addChild(rematch);

    const mainMenu = new Button({
      label: "MAIN MENU",
      width: BUTTON_W,
      height: BUTTON_H,
      onActivate: () => options.onMainMenu(),
    });
    mainMenu.x = rowX + BUTTON_W + rowGap;
    mainMenu.y = rowY;
    this.panel.addChild(mainMenu);

    this.focus.register(rematch);
    this.focus.register(mainMenu);
    this.focus.attach();
  }

  layout(viewWidth: number, viewHeight: number): void {
    this.panel.x = Math.round((viewWidth - PANEL_W) / 2);
    this.panel.y = Math.round((viewHeight - PANEL_H) / 2);
  }

  dispose(): void {
    this.focus.detach();
    this.focus.clear();
  }
}
