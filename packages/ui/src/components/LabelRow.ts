import { Container, Text } from "pixi.js";
import { color, typography } from "../tokens.js";

export const LABEL_ROW_HEIGHT = 24;

export interface LabelRowOptions {
  /** Left-aligned label. Rendered uppercase + muted by default. */
  label: string;
  /** Right-aligned control container. Owns its own width. */
  control: Container;
  /** Total row width. Control is right-aligned to this. */
  width: number;
  /** Override row height. Default {@link LABEL_ROW_HEIGHT}. */
  height?: number;
}

/**
 * One row in a settings panel: a left-aligned label paired with a
 * right-aligned control. Vertical centering is automatic, so cycles,
 * steppers, toggles, and bare text all line up regardless of their
 * intrinsic heights.
 */
export class LabelRow extends Container {
  readonly labelText: Text;
  readonly control: Container;
  readonly rowWidth: number;
  readonly rowHeight: number;

  constructor(options: LabelRowOptions) {
    super();
    this.rowWidth = options.width;
    this.rowHeight = options.height ?? LABEL_ROW_HEIGHT;

    this.labelText = new Text({
      text: options.label,
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.xs,
        fontWeight: typography.weight.bold,
        fill: color.textMuted,
        letterSpacing: typography.letterSpacing.wide,
      },
    });
    this.labelText.x = 0;
    this.labelText.y = Math.round((this.rowHeight - this.labelText.height) / 2);
    this.addChild(this.labelText);

    this.control = options.control;
    this.control.x = this.rowWidth - this.control.width;
    this.control.y = Math.round((this.rowHeight - this.control.height) / 2);
    this.addChild(this.control);
  }
}
