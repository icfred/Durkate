import {
  CARD_BACKGROUNDS,
  COLORWAYS,
  PATTERN_NAMES,
  type SkinSpec,
  type Tunables,
} from "@durak/skins-spike";

// CS:GO-style verbose card name generator. Produces a single readable
// string ("Factory New • Masterly Crafted Holographic • Huge Truchet •
// Aurora on Bone • with a Heavy Blue Tint"), per-component breakdown
// for tooltips, and an aggregate rarity grade derived from how
// extreme each value is.

export type Grade = "COMMON" | "UNCOMMON" | "RARE" | "EPIC" | "LEGENDARY" | "RELIC";

export interface NameComponent {
  /** Section label for the breakdown table (e.g. "FLOAT", "STRENGTH"). */
  label: string;
  /** Human-readable raw value (e.g. "0.04", "2.85"). */
  value: string;
  /** Bucketed word that appears in the name (e.g. "FACTORY NEW"). */
  word: string;
  /** Per-component rarity contribution. Sum drives the overall grade. */
  rarity: number;
}

export interface CardName {
  /** Composed full name. Bullet-separated phrases. */
  full: string;
  /** Ordered components for the hover tooltip. */
  components: NameComponent[];
  /** Sum of per-component rarities. */
  totalRarity: number;
  /** Mapped grade tier. */
  grade: Grade;
}

export function buildCardName(spec: SkinSpec, tunables: Tunables): CardName {
  const components: NameComponent[] = [];
  const phrases: string[] = [];

  // ── Float ──────────────────────────────────────────────────────────
  const wear = tunables.wear;
  const floatBucket = floatToWord(wear);
  components.push({
    label: "FLOAT",
    value: wear.toFixed(3),
    word: floatBucket.word,
    rarity: floatBucket.rarity,
  });
  phrases.push(floatBucket.word);

  // ── Strength + Finish ──────────────────────────────────────────────
  // Matte has no finish strength and no finish word; both are omitted
  // from the name when the user picked it.
  const finish = spec.finish;
  let finishStrengthRarity = 0;
  let finishRarity = 0;
  if (finish !== "matte") {
    const strength =
      finish === "holographic" ? tunables.foil.holographicStrength : tunables.foil.metalStrength;
    const strengthBucket = strengthToWord(strength);
    finishStrengthRarity = strengthBucket.rarity;
    components.push({
      label: "STRENGTH",
      value: strength.toFixed(2),
      word: `${strengthBucket.word} CRAFTED`,
      rarity: strengthBucket.rarity,
    });

    const finishBucket = finishToWord(finish);
    finishRarity = finishBucket.rarity;
    components.push({
      label: "FINISH",
      value: finish.toUpperCase(),
      word: finishBucket.word,
      rarity: finishBucket.rarity,
    });
    phrases.push(`${strengthBucket.word} CRAFTED ${finishBucket.word}`);
  }

  // ── Scale + Pattern ────────────────────────────────────────────────
  const patternScale = spec.pattern.scale;
  const scaleBucket = scaleToWord(patternScale);
  components.push({
    label: "SCALE",
    value: patternScale.toFixed(2),
    word: scaleBucket.word,
    rarity: scaleBucket.rarity,
  });

  const patternName = (PATTERN_NAMES[spec.pattern.index] ?? `P${spec.pattern.index}`).toUpperCase();
  components.push({
    label: "PATTERN",
    value: `#${spec.pattern.index}`,
    word: patternName,
    rarity: 0,
  });
  phrases.push(`${scaleBucket.word} ${patternName}`);

  // ── Colorway on Body ───────────────────────────────────────────────
  const colorway = (COLORWAYS[spec.colorway]?.name ?? `C${spec.colorway}`).toUpperCase();
  components.push({
    label: "COLORWAY",
    value: `#${spec.colorway}`,
    word: colorway,
    rarity: 0,
  });

  const body = (
    CARD_BACKGROUNDS[spec.cardBackground]?.name ?? `B${spec.cardBackground}`
  ).toUpperCase();
  components.push({
    label: "BODY",
    value: `#${spec.cardBackground}`,
    word: body,
    rarity: 0,
  });
  phrases.push(`${colorway} ON ${body}`);

  // ── Tint ───────────────────────────────────────────────────────────
  const saturation = spec.tint.saturation;
  const hueDeg = spec.tint.hue * 180;
  const tintBucket = tintToWord(saturation, hueDeg);
  components.push({
    label: "TINT",
    value: tintBucket.show ? `sat ${saturation.toFixed(2)}, hue ${hueDeg.toFixed(0)}°` : "—",
    word: tintBucket.show ? tintBucket.word : "NO TINT",
    rarity: tintBucket.rarity,
  });
  if (tintBucket.show) phrases.push(`WITH A ${tintBucket.word}`);

  const totalRarity =
    floatBucket.rarity +
    finishStrengthRarity +
    finishRarity +
    scaleBucket.rarity +
    tintBucket.rarity;

  return {
    full: phrases.join(" • "),
    components,
    totalRarity,
    grade: rarityToGrade(totalRarity),
  };
}

// ── Bucket helpers ────────────────────────────────────────────────────
//
// Each helper returns the displayed word plus a per-component rarity
// weight. Extremes (FACTORY NEW, BATTLE SCARRED, MASTERLY, WELL, HUGE,
// TINY) are rare; middle buckets are common.

interface Bucket {
  word: string;
  rarity: number;
}

function floatToWord(v: number): Bucket {
  // CS:GO float bands. Asymmetric — FN / BS occupy small ranges of the
  // 0..1 line and are scarcer than the broad FT band.
  if (v < 0.07) return { word: "FACTORY NEW", rarity: 5 };
  if (v < 0.15) return { word: "MINIMAL WEAR", rarity: 3 };
  if (v < 0.38) return { word: "FIELD TESTED", rarity: 1 };
  if (v < 0.45) return { word: "WELL WORN", rarity: 3 };
  return { word: "BATTLE SCARRED", rarity: 5 };
}

function strengthToWord(v: number): Bucket {
  if (v < 0.2) return { word: "WELL", rarity: 5 };
  if (v < 0.4) return { word: "FINE", rarity: 3 };
  if (v < 0.6) return { word: "SUPERIORALLY", rarity: 1 };
  if (v < 0.8) return { word: "EXCEPTIONALLY", rarity: 3 };
  return { word: "MASTERLY", rarity: 5 };
}

function finishToWord(finish: SkinSpec["finish"]): Bucket {
  switch (finish) {
    case "silver":
      return { word: "SILVER FOIL", rarity: 2 };
    case "gold":
      return { word: "GOLD FOIL", rarity: 3 };
    case "bronze":
      return { word: "BRONZE FOIL", rarity: 2 };
    case "holographic":
      return { word: "HOLOGRAPHIC", rarity: 5 };
    default:
      return { word: "", rarity: 0 };
  }
}

function scaleToWord(v: number): Bucket {
  if (v < 1.0) return { word: "TINY", rarity: 4 };
  if (v < 1.5) return { word: "SMALL", rarity: 2 };
  if (v < 2.0) return { word: "MEDIUM", rarity: 0 };
  if (v < 2.5) return { word: "LARGE", rarity: 2 };
  return { word: "HUGE", rarity: 4 };
}

interface TintBucket extends Bucket {
  show: boolean;
}

function tintToWord(saturation: number, hueDeg: number): TintBucket {
  // Below this threshold the tint is effectively grayscale and we omit
  // it from the name entirely. Still report a rarity contribution so a
  // "no tint" card grades slightly above a SLIGHT tint card.
  if (saturation < 0.1) return { show: false, word: "", rarity: 2 };
  let intensity: string;
  let intensityRarity: number;
  if (saturation < 0.5) {
    intensity = "SLIGHT";
    intensityRarity = 1;
  } else if (saturation < 1.0) {
    intensity = "DECENT";
    intensityRarity = 0;
  } else if (saturation < 1.5) {
    intensity = "STRONG";
    intensityRarity = 1;
  } else {
    intensity = "HEAVY";
    intensityRarity = 3;
  }
  return {
    show: true,
    word: `${intensity} ${hueToColorWord(hueDeg)} TINT`,
    rarity: intensityRarity,
  };
}

function hueToColorWord(hueDeg: number): string {
  // Normalise to [0, 360). 12-bucket colour wheel — granular enough for
  // the name to feel descriptive without colliding on neighbouring
  // hues.
  const h = ((hueDeg % 360) + 360) % 360;
  if (h < 15 || h >= 345) return "RED";
  if (h < 45) return "ORANGE";
  if (h < 75) return "AMBER";
  if (h < 105) return "LIME";
  if (h < 135) return "GREEN";
  if (h < 165) return "TEAL";
  if (h < 195) return "CYAN";
  if (h < 225) return "AZURE";
  if (h < 255) return "BLUE";
  if (h < 285) return "VIOLET";
  if (h < 315) return "MAGENTA";
  return "PINK";
}

function rarityToGrade(score: number): Grade {
  if (score < 4) return "COMMON";
  if (score < 8) return "UNCOMMON";
  if (score < 12) return "RARE";
  if (score < 16) return "EPIC";
  if (score < 20) return "LEGENDARY";
  return "RELIC";
}

// ── Grade colours ────────────────────────────────────────────────────

export const GRADE_COLOR: Record<Grade, number> = {
  COMMON: 0xa89968,
  UNCOMMON: 0x5a8a4a,
  RARE: 0x4a78b8,
  EPIC: 0x9a5ec0,
  LEGENDARY: 0xd08a3a,
  RELIC: 0xb04a3a,
};
