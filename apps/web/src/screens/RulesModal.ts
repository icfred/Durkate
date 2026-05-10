import { Button, color, FocusManager, Panel, spacing, typography } from "@durak/ui";
import { Container, Graphics, Text } from "pixi.js";

const PANEL_W = 560;
const BACKDROP_ALPHA = 0.78;
const CLOSE_BTN_W = 160;
const CLOSE_BTN_H = 44;

export interface RulesModalOptions {
  onClose(): void;
}

const RULES_LINES = [
  "GOAL — get rid of all your cards. Last player still",
  "holding cards is the DURAK (the loser).",
  "",
  "TRUMP — the suit shown under the deck beats every",
  "other suit. A higher card of the same suit, or any",
  "trump, beats a non-trump.",
  "",
  "ATTACK — play any card from your hand to start a bout.",
  "",
  "DEFEND — beat each attack with a higher same-suit card",
  "or a trump. Or TAKE the pile into your hand and skip",
  "your next attack.",
  "",
  "THROW IN — once a bout is open, anyone can throw in",
  "extra cards, but only of a rank already on the table.",
  "Cap: six attacks per bout, AND no more undefended",
  "attacks than the defender has cards in hand.",
  "",
  "END ROUND — once every attack is beaten, the attacker",
  "ends the round; defended cards go to the discard.",
  "",
  "DEAL — after every round, everyone draws back up to 6",
  "cards from the deck (attacker first). Once the deck is",
  "empty, you finish out with what's in hand.",
];

export class RulesModal extends Container {
  private readonly backdrop: Graphics;
  private readonly panel: Panel;
  private readonly panelHeight: number;
  private readonly focus: FocusManager;
  private readonly detachEscape: () => void;

  constructor(options: RulesModalOptions) {
    super();
    this.eventMode = "static";

    this.backdrop = new Graphics();
    this.backdrop.eventMode = "static";
    this.backdrop.cursor = "pointer";
    this.backdrop.on("pointertap", () => options.onClose());
    this.addChild(this.backdrop);

    const title = new Text({
      text: "RULES",
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.xxl,
        fontWeight: typography.weight.bold,
        fill: color.text,
        letterSpacing: typography.letterSpacing.stamp,
      },
    });

    const body = new Text({
      text: RULES_LINES.join("\n"),
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.sm,
        fill: color.textMuted,
        letterSpacing: typography.letterSpacing.wide,
        align: "left",
        lineHeight: 20,
      },
    });

    const titleY = spacing.xl;
    const bodyY = titleY + title.height + spacing.lg;
    const buttonY = bodyY + body.height + spacing.lg;
    this.panelHeight = buttonY + CLOSE_BTN_H + spacing.xl;

    this.panel = new Panel({ width: PANEL_W, height: this.panelHeight });
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
