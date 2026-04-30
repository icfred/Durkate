import { Button, color, FocusManager, Panel, spacing, typography } from "@durak/ui";
import { Container, Text } from "pixi.js";
import { attachButtonHover, playSfx, SFX_NAMES, type SfxName } from "../../audio/index.js";
import type { Screen } from "../../screens/types.js";

const PANEL_PADDING = spacing.lg;
const BUTTON_W = 200;
const BUTTON_H = 44;
const COL_GAP = spacing.md;
const ROW_GAP = spacing.sm;
const COLS = 3;

export class SfxSandboxScreen extends Container implements Screen {
  private readonly focus = new FocusManager();
  private readonly panel: Panel;
  private readonly title: Text;
  private readonly hint: Text;
  private readonly status: Text;
  private readonly grid: Container;

  constructor() {
    super();

    const rows = Math.ceil(SFX_NAMES.length / COLS);
    const gridW = COLS * BUTTON_W + (COLS - 1) * COL_GAP;
    const gridH = rows * BUTTON_H + (rows - 1) * ROW_GAP;
    const panelW = gridW + PANEL_PADDING * 2;
    const panelH = gridH + PANEL_PADDING * 2 + spacing.xl * 3;

    this.panel = new Panel({ width: panelW, height: panelH });
    this.addChild(this.panel);

    this.title = new Text({
      text: "SFX SANDBOX",
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.lg,
        fontWeight: typography.weight.bold,
        fill: color.text,
        letterSpacing: typography.letterSpacing.stamp,
      },
    });
    this.title.x = PANEL_PADDING;
    this.title.y = PANEL_PADDING;
    this.panel.addChild(this.title);

    this.hint = new Text({
      text: "HOVER TO PREVIEW  -  CLICK / ENTER TO REPLAY",
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.xs,
        fill: color.textMuted,
        letterSpacing: typography.letterSpacing.wide,
      },
    });
    this.hint.x = PANEL_PADDING;
    this.hint.y = this.title.y + this.title.height + spacing.xs;
    this.panel.addChild(this.hint);

    this.status = new Text({
      text: "READY",
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.sm,
        fontWeight: typography.weight.bold,
        fill: color.accent,
        letterSpacing: typography.letterSpacing.wide,
      },
    });
    this.status.x = PANEL_PADDING;
    this.status.y = this.hint.y + this.hint.height + spacing.sm;
    this.panel.addChild(this.status);

    this.grid = new Container();
    this.grid.x = PANEL_PADDING;
    this.grid.y = this.status.y + this.status.height + spacing.md;
    this.panel.addChild(this.grid);

    SFX_NAMES.forEach((name, i) => {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const button = new Button({
        label: name,
        width: BUTTON_W,
        height: BUTTON_H,
        onActivate: () => this.preview(name),
      });
      button.x = col * (BUTTON_W + COL_GAP);
      button.y = row * (BUTTON_H + ROW_GAP);
      attachButtonHover(button);
      button.on("pointerover", () => this.preview(name));
      this.grid.addChild(button);
      this.focus.register(button);
    });

    this.focus.attach();
  }

  layout(viewWidth: number, viewHeight: number): void {
    this.panel.x = Math.round((viewWidth - this.panel.width) / 2);
    this.panel.y = Math.round((viewHeight - this.panel.height) / 2);
  }

  dispose(): void {
    this.focus.detach();
    this.focus.clear();
  }

  private preview(name: SfxName): void {
    this.status.text = `PLAYING ${name}`;
    playSfx(name);
  }
}
