import { color, typography } from "@durak/ui";
import { Container, Text } from "pixi.js";
import type { Screen } from "./types.js";

export class PlaceholderScreen extends Container implements Screen {
  private readonly text: Text;

  constructor(label: string) {
    super();
    this.text = new Text({
      text: `${label} (TBD)`,
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.lg,
        fill: color.textMuted,
        letterSpacing: typography.letterSpacing.wide,
      },
    });
    this.addChild(this.text);
  }

  layout(viewWidth: number, viewHeight: number): void {
    this.text.x = Math.round((viewWidth - this.text.width) / 2);
    this.text.y = Math.round((viewHeight - this.text.height) / 2);
  }

  dispose(): void {}
}
