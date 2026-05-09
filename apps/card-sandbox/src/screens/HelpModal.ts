import { Button, color, FocusManager, Panel, spacing, typography } from "@durak/ui";
import { Container, Graphics, Text } from "pixi.js";
import type { Screen } from "./types.js";

const PANEL_W = 480;
// Panel height computed at construction time from actual title + body +
// button heights so we never see the close button overlap the last line
// of the body, regardless of how many lines the explainer grows to.
const BACKDROP_ALPHA = 0.7;
const CLOSE_BTN_W = 160;
const CLOSE_BTN_H = 44;

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
  private readonly panelHeight: number;
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

    // Layout vertically; panel height tracks actual content so a longer
    // body never gets buried under the close button.
    const titleY = spacing.xl;
    const bodyY = titleY + title.height + spacing.lg;
    const buttonY = bodyY + body.height + spacing.lg;
    this.panelHeight = buttonY + CLOSE_BTN_H + spacing.xl;

    this.panel = new Panel({ width: PANEL_W, height: this.panelHeight });
    // The panel itself swallows pointer events so backdrop clicks don't
    // dismiss the modal when the user clicks inside the body.
    this.panel.eventMode = "static";
    this.panel.on("pointertap", (event) => event.stopPropagation());
    this.addChild(this.panel);

    title.x = Math.round((PANEL_W - title.width) / 2);
    title.y = titleY;
    this.panel.addChild(title);

    body.x = Math.round((PANEL_W - body.width) / 2);
    body.y = bodyY;
    this.panel.addChild(body);

    const closeBtn = new Button({
      label: "CLOSE",
      width: CLOSE_BTN_W,
      height: CLOSE_BTN_H,
      onActivate: () => options.onClose(),
    });
    closeBtn.x = Math.round((PANEL_W - CLOSE_BTN_W) / 2);
    closeBtn.y = buttonY;
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
    this.panel.y = Math.round((viewHeight - this.panelHeight) / 2);
  }

  dispose(): void {
    this.detachEscape();
    this.focus.detach();
    this.focus.clear();
  }
}
