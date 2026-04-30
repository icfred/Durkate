import { Button, color, FocusManager, Panel, spacing, typography } from "@durak/ui";
import { Container, Text } from "pixi.js";
import { attachButtonHover, attachFocusNavSfx, withClickSound } from "../audio/index.js";
import type { GameOverData } from "../store.js";
import { attachBackNav } from "./backNav.js";
import type { Screen } from "./types.js";

const PANEL_W = 480;
const PANEL_H = 360;
const BUTTON_W = 200;
const BUTTON_H = 56;

export type Outcome = "victory" | "defeat" | "draw";

export interface RematchStatus {
  youRequested: boolean;
  opponentRequested: boolean;
}

export interface GameOverScreenOptions {
  data: GameOverData;
  initialRematch?: RematchStatus;
  subscribeRematch?: (cb: (status: RematchStatus) => void) => () => void;
  onRematch(): void;
  onMainMenu(): void;
}

const KEYBOARD_HINT = "ARROWS MOVE  -  ENTER ACTIVATES";
const REMATCH_LABEL = "REMATCH";
const REMATCH_PENDING_LABEL = "WAITING...";

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
  private readonly hint: Text;
  private readonly rematchButton: Button;
  private readonly detachFocusNavSfx: () => void;
  private readonly detachBackNav: () => void;
  private readonly unsubscribeRematch: (() => void) | undefined;
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

    this.hint = new Text({
      text: KEYBOARD_HINT,
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.xs,
        fill: color.textMuted,
        letterSpacing: typography.letterSpacing.wide,
      },
    });
    this.hint.x = Math.round((PANEL_W - this.hint.width) / 2);
    this.hint.y = subline.y + subline.height + spacing.xs;
    this.panel.addChild(this.hint);

    const rowGap = spacing.md;
    const rowWidth = BUTTON_W * 2 + rowGap;
    const rowX = Math.round((PANEL_W - rowWidth) / 2);
    const rowY = PANEL_H - BUTTON_H - spacing.xl;

    this.rematchButton = new Button({
      label: REMATCH_LABEL,
      width: BUTTON_W,
      height: BUTTON_H,
      onActivate: withClickSound(() => {
        // Optimistic local feedback. The server round-trip then either
        // fires the rematch (snapshot drops the screen) or echoes a
        // RoomState that confirms the pending hint.
        this.applyRematchStatus({ youRequested: true, opponentRequested: false });
        options.onRematch();
      }),
    });
    attachButtonHover(this.rematchButton);
    this.rematchButton.x = rowX;
    this.rematchButton.y = rowY;
    this.panel.addChild(this.rematchButton);

    const mainMenu = new Button({
      label: "MAIN MENU",
      width: BUTTON_W,
      height: BUTTON_H,
      onActivate: withClickSound(() => options.onMainMenu()),
    });
    attachButtonHover(mainMenu);
    mainMenu.x = rowX + BUTTON_W + rowGap;
    mainMenu.y = rowY;
    this.panel.addChild(mainMenu);

    this.focus.register(this.rematchButton);
    this.focus.register(mainMenu);
    this.focus.attach();
    this.detachFocusNavSfx = attachFocusNavSfx(this.focus);
    this.detachBackNav = attachBackNav({ onBack: options.onMainMenu });

    if (options.initialRematch) this.applyRematchStatus(options.initialRematch);
    this.unsubscribeRematch = options.subscribeRematch?.((status) =>
      this.applyRematchStatus(status),
    );
  }

  private applyRematchStatus(status: RematchStatus): void {
    if (status.youRequested) {
      this.rematchButton.setLabel(REMATCH_PENDING_LABEL);
      this.setHint("WAITING FOR OPPONENT");
      return;
    }
    this.rematchButton.setLabel(REMATCH_LABEL);
    if (status.opponentRequested) {
      this.setHint("OPPONENT WANTS REMATCH");
      return;
    }
    this.setHint(KEYBOARD_HINT);
  }

  private setHint(text: string): void {
    this.hint.text = text;
    this.hint.x = Math.round((PANEL_W - this.hint.width) / 2);
  }

  layout(viewWidth: number, viewHeight: number): void {
    this.panel.x = Math.round((viewWidth - PANEL_W) / 2);
    this.panel.y = Math.round((viewHeight - PANEL_H) / 2);
  }

  dispose(): void {
    this.detachBackNav();
    this.detachFocusNavSfx();
    this.unsubscribeRematch?.();
    this.focus.detach();
    this.focus.clear();
  }
}
