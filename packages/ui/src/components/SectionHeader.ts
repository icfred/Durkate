import { Text } from "pixi.js";
import { color, typography } from "../tokens.js";

/**
 * Stamped, brick-red small-caps section label. Used as a header above
 * a `Stack` of `LabelRow`s. Stick to one per section — multiple in a
 * row read as competing accents instead of structure.
 */
export class SectionHeader extends Text {
  constructor(text: string) {
    super({
      text,
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.sm,
        fontWeight: typography.weight.bold,
        fill: color.accent,
        letterSpacing: typography.letterSpacing.stamp,
      },
    });
  }
}
