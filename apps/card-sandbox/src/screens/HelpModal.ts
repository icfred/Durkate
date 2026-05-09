import { Button, color, FocusManager, Panel, spacing, typography } from "@durak/ui";
import { Container, Graphics, Text } from "pixi.js";
import type { Screen } from "./types.js";

const PANEL_W = 480;
const PANEL_H = 360;
const BACKDROP_ALPHA = 0.7;

export interface HelpModalOptions {
  onClose(): void;
}

// Full-screen overlay with a centered panel describing what the sandbox is.
// Dismissed via Esc, the close button, or clicking the backdrop. Builds its
// own FocusManager so keyboard nav inside the modal doesn't leak back to
// the underlying grid screen.
export class HelpModal extends Container implements Screen {
  private readonly backdrop: Graphics;
  private readonly panel: Panel;
  private readonly focus: FocusManager;
  private readonly detachEscape: () => void;

  constructor(options: HelpModalOptions) {
    super();
    this.eventMode = "static";

    this.backdrop = new Graphics();
    this.backdrop.eventMode = "static";
    this.backdrop.cursor = "pointer";
    this.backdrop.on("pointertap", () => options.onClose());
    this.addChild(this.backdrop);

    this.panel = new Panel({ width: PANEL_W, height: PANEL_H });
    // The panel itself swallows pointer events so backdrop clicks don't
    // dismiss the modal when the user clicks inside the body.
    this.panel.eventMode = "static";
    this.panel.on("pointertap", (event) => event.stopPropagation());
    this.addChild(this.panel);

    const title = new Text({
      text: "CARD SANDBOX",
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.xxl,
        fontWeight: typography.weight.bold,
        fill: color.text,
        letterSpacing: typography.letterSpacing.stamp,
      },
    });
    title.x = Math.round((PANEL_W - title.width) / 2);
    title.y = spacing.xl;
    this.panel.addChild(title);

    const lines = [
      "A live showcase of the procedural card-back",
      "pattern system used in Durak.",
      "",
      "Arrow keys or mouse to navigate.",
      "Click any card to open the tuner",
      "and tweak its parameters.",
      "",
      "Animation primitives demo: ?screen=anims",
    ];
    const body = new Text({
      text: lines.join("\n"),
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.sm,
        fill: color.textMuted,
        letterSpacing: typography.letterSpacing.wide,
        align: "center",
        lineHeight: 22,
      },
    });
    body.x = Math.round((PANEL_W - body.width) / 2);
    body.y = title.y + title.height + spacing.lg;
    this.panel.addChild(body);

    const closeBtn = new Button({
      label: "CLOSE",
      width: 160,
      height: 44,
      onActivate: () => options.onClose(),
    });
    closeBtn.x = Math.round((PANEL_W - 160) / 2);
    closeBtn.y = PANEL_H - 44 - spacing.xl;
    this.panel.addChild(closeBtn);

    this.focus = new FocusManager();
    this.focus.register(closeBtn);
    this.focus.attach();
    this.detachEscape = this.focus.subscribeEscape(() => options.onClose());
  }

  layout(viewWidth: number, viewHeight: number): void {
    this.backdrop
      .clear()
      .rect(0, 0, viewWidth, viewHeight)
      .fill({ color: 0x000000, alpha: BACKDROP_ALPHA });
    this.panel.x = Math.round((viewWidth - PANEL_W) / 2);
    this.panel.y = Math.round((viewHeight - PANEL_H) / 2);
  }

  dispose(): void {
    this.detachEscape();
    this.focus.detach();
    this.focus.clear();
  }
}
