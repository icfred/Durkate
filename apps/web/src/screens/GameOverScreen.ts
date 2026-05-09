import type { MatchState } from "@durak/protocol";
import { Button, color, FocusManager, Panel, spacing, typography } from "@durak/ui";
import { Container, Text } from "pixi.js";
import { attachButtonHover, attachFocusNavSfx, withClickSound } from "../audio/index.js";
import type { GameOverData } from "../store.js";
import { attachBackNav } from "./backNav.js";
import type { Screen } from "./types.js";

const PANEL_W = 480;
const PANEL_H = 360;
const PANEL_H_MATCH = 480;
const BUTTON_W = 200;
const BUTTON_H = 56;

export type Outcome = "victory" | "defeat" | "draw";

export interface RematchStatus {
  youRequested: boolean;
  opponentRequested: boolean;
}

export interface GameOverScreenOptions {
  data: GameOverData;
  /**
   * Best-of-N match state at the moment of game-over. When a match is
   * still in progress (totalRounds > 1 and !matchOver), the screen
   * shows the running scoreboard and a NEXT ROUND button instead of
   * the standard REMATCH. When the match is over, scoreboard plus a
   * REMATCH button (which restarts the whole series).
   */
  match?: MatchState | null;
  initialRematch?: RematchStatus;
  subscribeRematch?: (cb: (status: RematchStatus) => void) => () => void;
  onRematch(): void;
  /**
   * Advance to the next round of an in-progress match. Wired to the
   * StartGame WS message via the store. Only called when `match` is
   * present and `match.matchOver === false`.
   */
  onNextRound?(): void;
  onMainMenu(): void;
}

const KEYBOARD_HINT = "ARROWS MOVE  -  ENTER ACTIVATES";
const REMATCH_LABEL = "REMATCH";
const REMATCH_PENDING_LABEL = "WAITING...";
const NEXT_ROUND_LABEL = "NEXT ROUND";

export function classifyOutcome(data: GameOverData): Outcome {
  if (data.durak === null) return "draw";
  return data.durak === data.youSeat ? "defeat" : "victory";
}

function sublineFor(data: GameOverData, outcome: Outcome): string {
  if (outcome === "draw") return "No durak this round";
  const seat = data.durak;
  if (seat === null) return "";
  const name = data.seatNames?.[seat]?.trim();
  const who = name && name.length > 0 ? name : `Player ${seat + 1}`;
  return `${who} is the Durak`;
}

// In-match headline. While the match is still being played, surface
// the round counter so the player knows where they are. When the match
// is over, prepend "MATCH OVER" so it's clear there's a winner.
function matchAwareHeadline(outcome: Outcome, match: MatchState | null): string {
  if (!match) {
    switch (outcome) {
      case "victory":
        return "VICTORY";
      case "defeat":
        return "DURAK";
      case "draw":
        return "DRAW";
    }
  }
  if (match.matchOver) return "MATCH OVER";
  switch (outcome) {
    case "victory":
      return "ROUND WON";
    case "defeat":
      return "ROUND LOST";
    case "draw":
      return "ROUND DRAW";
  }
}

function matchProgressLabel(match: MatchState): string {
  if (match.matchOver) {
    return `BEST OF ${match.totalRounds} — FINAL`;
  }
  return `ROUND ${match.currentRound} OF ${match.totalRounds}`;
}

interface ScoreRow {
  seat: number;
  label: string;
  you: boolean;
}

// Build a per-seat scoreboard for the match. Sorted ascending by score
// (lowest pts = best) so the leader reads at the top. The local seat
// is marked "(you)" so the player can find themselves at a glance.
function rankSeats(match: MatchState, seatNames: ReadonlyArray<string | null>): ScoreRow[] {
  const rows = match.scores.map((score, seat) => {
    const rawName = seatNames[seat]?.trim?.();
    const name = rawName && rawName.length > 0 ? rawName : `Player ${seat + 1}`;
    return { seat, score, name };
  });
  rows.sort((a, b) => a.score - b.score || a.seat - b.seat);
  return rows.map((r) => ({
    seat: r.seat,
    label: `${r.name.toUpperCase()}   ${r.score} ${r.score === 1 ? "PT" : "PTS"}`,
    you: false,
  }));
}

export class GameOverScreen extends Container implements Screen {
  private readonly focus = new FocusManager();
  private readonly panel: Panel;
  private readonly hint: Text;
  private readonly rematchButton: Button;
  private readonly detachFocusNavSfx: () => void;
  private readonly detachBackNav: () => void;
  private readonly unsubscribeRematch: (() => void) | undefined;
  private readonly inProgressMatch: boolean;
  readonly outcome: Outcome;
  readonly panelHeight: number;

  constructor(options: GameOverScreenOptions) {
    super();
    this.outcome = classifyOutcome(options.data);
    const match = options.match ?? null;
    this.inProgressMatch = match !== null && !match.matchOver;
    const showMatch = match !== null;
    this.panelHeight = showMatch ? PANEL_H_MATCH : PANEL_H;

    this.panel = new Panel({ width: PANEL_W, height: this.panelHeight });
    this.addChild(this.panel);

    const headline = new Text({
      text: matchAwareHeadline(this.outcome, match),
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

    let nextY = subline.y + subline.height + spacing.md;

    if (showMatch && match) {
      const matchInfo = new Text({
        text: matchProgressLabel(match),
        style: {
          fontFamily: typography.family,
          fontSize: typography.size.sm,
          fontWeight: typography.weight.bold,
          fill: color.accent,
          letterSpacing: typography.letterSpacing.wide,
        },
      });
      matchInfo.x = Math.round((PANEL_W - matchInfo.width) / 2);
      matchInfo.y = nextY;
      this.panel.addChild(matchInfo);
      nextY = matchInfo.y + matchInfo.height + spacing.sm;

      // Per-seat scoreboard. Sorted ascending by score so the leader
      // (fewest losses) reads at the top.
      const ranking = rankSeats(match, options.data.seatNames ?? []);
      for (const row of ranking) {
        const t = new Text({
          text: row.label,
          style: {
            fontFamily: typography.family,
            fontSize: typography.size.sm,
            fill: row.you ? color.text : color.textMuted,
            letterSpacing: typography.letterSpacing.tight,
          },
        });
        t.x = Math.round((PANEL_W - t.width) / 2);
        t.y = nextY;
        this.panel.addChild(t);
        nextY = t.y + t.height + 2;
      }
      nextY += spacing.sm;
    }

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
    this.hint.y = nextY;
    this.panel.addChild(this.hint);

    const rowGap = spacing.md;
    const rowWidth = BUTTON_W * 2 + rowGap;
    const rowX = Math.round((PANEL_W - rowWidth) / 2);
    const rowY = this.panelHeight - BUTTON_H - spacing.xl;

    // Primary action — NEXT ROUND mid-match, REMATCH otherwise. The
    // optimistic-local-feedback path stays for the rematch case so the
    // host's button reflects the pending state while the server confirms.
    this.rematchButton = new Button({
      label: this.inProgressMatch ? NEXT_ROUND_LABEL : REMATCH_LABEL,
      width: BUTTON_W,
      height: BUTTON_H,
      onActivate: withClickSound(() => {
        if (this.inProgressMatch) {
          options.onNextRound?.();
          return;
        }
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
    // Mid-match the primary action is "NEXT ROUND" (host-driven, no
    // pending state) — rematch UI is suppressed entirely.
    if (this.inProgressMatch) return;
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
    this.panel.y = Math.round((viewHeight - this.panelHeight) / 2);
  }

  dispose(): void {
    this.detachBackNav();
    this.detachFocusNavSfx();
    this.unsubscribeRematch?.();
    this.focus.detach();
    this.focus.clear();
  }
}
