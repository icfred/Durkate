import { color, type Focusable, typography } from "@durak/ui";
import { Container, Graphics, Text } from "pixi.js";
import { CARD_H, CARD_W } from "../cards/CardView.js";

// A card-shaped tile that renders a single "?" glyph in its centre and
// nothing else. Lives at a fixed slot in the grid (middle cell) and acts
// as the entry point for the explainer modal — clicking it opens the
// modal, hovering / arrow-focusing it pulses the border just like any
// other tile so the ripple animation reads consistently.
export class HelpCard extends Container implements Focusable {
  private readonly bg: Graphics;
  private readonly border: Graphics;
  private readonly mark: Text;
  private focused = false;
  onActivate: (() => void) | undefined;

  constructor() {
    super();
    this.bg = new Graphics();
    this.addChild(this.bg);
    this.border = new Graphics();
    this.addChild(this.border);
    this.mark = new Text({
      text: "?",
      style: {
        fontFamily: typography.family,
        fontSize: 48,
        fontWeight: typography.weight.bold,
        fill: color.accent,
        letterSpacing: typography.letterSpacing.tight,
      },
    });
    this.mark.resolution = 3;
    this.addChild(this.mark);
    this.eventMode = "static";
    this.cursor = "pointer";
    this.on("pointertap", () => this.onActivate?.());
    this.redraw();
  }

  setFocus(focused: boolean): void {
    if (this.focused === focused) return;
    this.focused = focused;
    this.redraw();
  }

  activate(): void {
    this.onActivate?.();
  }

  private redraw(): void {
    this.bg.clear().roundRect(0, 0, CARD_W, CARD_H, 4).fill({ color: color.bgRaised });
    const borderColor = this.focused ? color.borderFocus : color.border;
    const borderWidth = this.focused ? 3 : 2;
    this.border
      .clear()
      .roundRect(0, 0, CARD_W, CARD_H, 4)
      .stroke({ color: borderColor, width: borderWidth, alignment: 0 });
    this.mark.x = Math.round((CARD_W - this.mark.width) / 2);
    this.mark.y = Math.round((CARD_H - this.mark.height) / 2);
  }
}
