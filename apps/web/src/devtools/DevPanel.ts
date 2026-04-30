import { color, spacing, stroke, typography } from "@durak/ui";
import { Container, Graphics, Text } from "pixi.js";
import type { StoreApi } from "zustand/vanilla";
import { ANIM_SPEED_MAX, ANIM_SPEED_MIN, type AppState } from "../store.js";

const PANEL_WIDTH = 380;
const PANEL_PADDING = spacing.md;
const PANEL_MARGIN = spacing.sm;
const SECTION_GAP = spacing.sm;
const ROW_HEIGHT = 24;
const SNAPSHOT_VIEW_HEIGHT = 220;
const EVENTS_VIEW_HEIGHT = 100;
const SLIDER_WIDTH = 160;
const SLIDER_HEIGHT = 16;
const EVENT_BUFFER_VISIBLE = 16;

export interface DevPanelOptions {
  store: StoreApi<AppState>;
  /** Force-close the active websocket. Wired by `main.ts` from the connection controller. */
  forceDisconnect?: () => void;
}

interface ToggleRow {
  container: Container;
  redraw(active: boolean): void;
}

/**
 * Pixi overlay that shows live store state and exposes a few dev toggles.
 * Hidden by default; visibility tracks `appStore.devtools.open`.
 */
export class DevPanel extends Container {
  private readonly store: StoreApi<AppState>;
  private readonly forceDisconnect: (() => void) | undefined;
  private readonly bg: Graphics;
  private readonly statusText: Text;
  private readonly phaseText: Text;
  private readonly snapshotText: Text;
  private readonly snapshotMask: Graphics;
  private readonly snapshotScroller: Container;
  private readonly eventsText: Text;
  private readonly eventsMask: Graphics;
  private readonly eventsScroller: Container;
  private readonly autoplayRow: ToggleRow;
  private readonly muteRow: ToggleRow;
  private readonly disconnectButton: Container;
  private readonly sliderHost: Container;
  private readonly sliderTrack: Graphics;
  private readonly sliderThumb: Graphics;
  private readonly sliderValueText: Text;
  private snapshotScroll = 0;
  private snapshotContentHeight = 0;
  private unsubscribe: (() => void) | null = null;
  private keyHandler: ((event: KeyboardEvent) => void) | null = null;
  private panelHeight = 0;

  constructor(options: DevPanelOptions) {
    super();
    this.store = options.store;
    this.forceDisconnect = options.forceDisconnect;
    this.eventMode = "static";

    this.bg = new Graphics();
    this.addChild(this.bg);

    this.statusText = makeText("");
    this.phaseText = makeText("");
    this.addChild(this.statusText, this.phaseText);

    this.snapshotScroller = new Container();
    this.snapshotMask = new Graphics();
    this.snapshotText = makeMonoText("");
    this.snapshotScroller.addChild(this.snapshotText);
    this.addChild(this.snapshotMask, this.snapshotScroller);
    this.snapshotScroller.mask = this.snapshotMask;

    this.eventsScroller = new Container();
    this.eventsMask = new Graphics();
    this.eventsText = makeMonoText("");
    this.eventsScroller.addChild(this.eventsText);
    this.addChild(this.eventsMask, this.eventsScroller);
    this.eventsScroller.mask = this.eventsMask;

    this.autoplayRow = makeToggleRow("Autoplay", () => {
      this.store.getState().setAutoplay(!this.store.getState().devtools.autoplay);
    });
    this.muteRow = makeToggleRow("Mute", () => {
      this.store.getState().toggleMute();
    });
    this.addChild(this.autoplayRow.container, this.muteRow.container);

    this.sliderHost = new Container();
    this.sliderHost.eventMode = "static";
    this.sliderTrack = new Graphics();
    this.sliderThumb = new Graphics();
    this.sliderValueText = makeText("");
    this.sliderHost.addChild(this.sliderTrack, this.sliderThumb, this.sliderValueText);
    this.sliderHost.on("pointerdown", (event) => {
      const local = this.sliderHost.toLocal({ x: event.global.x, y: event.global.y });
      const ratio = Math.min(1, Math.max(0, local.x / SLIDER_WIDTH));
      this.store
        .getState()
        .setAnimSpeed(ANIM_SPEED_MIN + ratio * (ANIM_SPEED_MAX - ANIM_SPEED_MIN));
    });
    this.addChild(this.sliderHost);

    this.disconnectButton = makeMiniButton("Disconnect ws", () => {
      this.forceDisconnect?.();
    });
    this.addChild(this.disconnectButton);

    this.visible = this.store.getState().devtools.open;
  }

  /** Subscribe to store + install scroll keys. Call once after construction. */
  attach(): void {
    if (this.unsubscribe) return;
    this.render();
    this.unsubscribe = this.store.subscribe(() => this.render());
    if (typeof window !== "undefined") {
      const keyHandler = (event: KeyboardEvent): void => {
        const state = this.store.getState();
        if (!state.devtools.open) return;
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        const target = event.target;
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? ROW_HEIGHT : -ROW_HEIGHT;
        const max = Math.max(0, this.snapshotContentHeight - SNAPSHOT_VIEW_HEIGHT);
        this.snapshotScroll = Math.max(0, Math.min(this.snapshotScroll + delta, max));
        this.snapshotText.y = -this.snapshotScroll;
      };
      this.keyHandler = keyHandler;
      window.addEventListener("keydown", keyHandler);
    }
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.keyHandler && typeof window !== "undefined") {
      window.removeEventListener("keydown", this.keyHandler);
    }
    this.keyHandler = null;
  }

  /** Position the panel against the viewport's top-right corner. */
  layout(viewWidth: number, _viewHeight: number): void {
    this.x = viewWidth - PANEL_WIDTH - PANEL_MARGIN;
    this.y = PANEL_MARGIN;
  }

  private render(): void {
    const state = this.store.getState();
    this.visible = state.devtools.open;
    if (!this.visible) return;

    const conn = state.connection;
    const errSuffix = conn.error ? `, err=${conn.error}` : "";
    this.statusText.text = `ws: ${conn.status} (attempts=${conn.attempts}${errSuffix})`;
    this.phaseText.text = `phase: ${state.phase}`;

    this.snapshotText.text = state.snapshot
      ? JSON.stringify(state.snapshot, null, 2)
      : "(no snapshot)";
    this.snapshotContentHeight = this.snapshotText.height;
    const maxScroll = Math.max(0, this.snapshotContentHeight - SNAPSHOT_VIEW_HEIGHT);
    if (this.snapshotScroll > maxScroll) {
      this.snapshotScroll = maxScroll;
    }
    this.snapshotText.y = -this.snapshotScroll;

    const eventLines = state.events.slice(-EVENT_BUFFER_VISIBLE).map(formatEvent);
    this.eventsText.text = eventLines.length > 0 ? eventLines.join("\n") : "(no events)";
    const evMax = Math.max(0, this.eventsText.height - EVENTS_VIEW_HEIGHT);
    this.eventsText.y = -evMax;

    this.autoplayRow.redraw(state.devtools.autoplay);
    this.muteRow.redraw(state.audio.muted);

    const ratio = (state.devtools.animSpeed - ANIM_SPEED_MIN) / (ANIM_SPEED_MAX - ANIM_SPEED_MIN);
    this.sliderThumb.x = ratio * SLIDER_WIDTH - 4;
    this.sliderValueText.text = `${state.devtools.animSpeed.toFixed(2)}x`;

    this.relayoutChildren();
  }

  private relayoutChildren(): void {
    let y = PANEL_PADDING;
    this.statusText.x = PANEL_PADDING;
    this.statusText.y = y;
    y += ROW_HEIGHT;
    this.phaseText.x = PANEL_PADDING;
    this.phaseText.y = y;
    y += ROW_HEIGHT + SECTION_GAP;

    this.snapshotMask
      .clear()
      .rect(PANEL_PADDING, y, PANEL_WIDTH - PANEL_PADDING * 2, SNAPSHOT_VIEW_HEIGHT)
      .fill({ color: 0xffffff });
    this.snapshotScroller.x = PANEL_PADDING;
    this.snapshotScroller.y = y;
    y += SNAPSHOT_VIEW_HEIGHT + SECTION_GAP;

    this.eventsMask
      .clear()
      .rect(PANEL_PADDING, y, PANEL_WIDTH - PANEL_PADDING * 2, EVENTS_VIEW_HEIGHT)
      .fill({ color: 0xffffff });
    this.eventsScroller.x = PANEL_PADDING;
    this.eventsScroller.y = y;
    y += EVENTS_VIEW_HEIGHT + SECTION_GAP;

    this.autoplayRow.container.x = PANEL_PADDING;
    this.autoplayRow.container.y = y;
    y += ROW_HEIGHT;
    this.muteRow.container.x = PANEL_PADDING;
    this.muteRow.container.y = y;
    y += ROW_HEIGHT + SECTION_GAP;

    this.sliderHost.x = PANEL_PADDING;
    this.sliderHost.y = y;
    this.sliderTrack
      .clear()
      .rect(0, SLIDER_HEIGHT / 2 - 2, SLIDER_WIDTH, 4)
      .fill({ color: color.border });
    this.sliderThumb.clear().rect(0, 0, 8, SLIDER_HEIGHT).fill({ color: color.accent });
    this.sliderValueText.x = SLIDER_WIDTH + spacing.sm;
    this.sliderValueText.y = -2;
    y += SLIDER_HEIGHT + SECTION_GAP;

    this.disconnectButton.x = PANEL_PADDING;
    this.disconnectButton.y = y;
    y += ROW_HEIGHT + PANEL_PADDING;

    this.panelHeight = y;
    this.bg
      .clear()
      .rect(0, 0, PANEL_WIDTH, this.panelHeight)
      .fill({ color: color.bgRaised, alpha: 0.96 })
      .stroke({ color: color.border, width: stroke.base, alignment: 0 });
  }
}

function makeText(text: string): Text {
  return new Text({
    text,
    style: {
      fontFamily: typography.family,
      fontSize: typography.size.sm,
      fill: color.text,
    },
  });
}

function makeMonoText(text: string): Text {
  return new Text({
    text,
    style: {
      fontFamily: typography.families.utility,
      fontSize: typography.size.xs,
      fill: color.text,
      lineHeight: 14,
      wordWrap: true,
      wordWrapWidth: PANEL_WIDTH - PANEL_PADDING * 2 - 4,
    },
  });
}

function makeToggleRow(label: string, onToggle: () => void): ToggleRow {
  const container = new Container();
  container.eventMode = "static";
  container.cursor = "pointer";
  const labelText = makeText(label);
  const indicator = new Graphics();
  container.addChild(indicator, labelText);
  labelText.x = 22;
  container.on("pointerdown", () => onToggle());
  const redraw = (active: boolean): void => {
    indicator
      .clear()
      .rect(0, 4, 14, 14)
      .fill({ color: active ? color.accent : color.bgSunken })
      .stroke({ color: color.border, width: stroke.thin });
    labelText.text = `${label}: ${active ? "on" : "off"}`;
  };
  return { container, redraw };
}

function makeMiniButton(label: string, onClick: () => void): Container {
  const container = new Container();
  container.eventMode = "static";
  container.cursor = "pointer";
  const bg = new Graphics()
    .rect(0, 0, 140, 22)
    .fill({ color: color.accentDim })
    .stroke({ color: color.border, width: stroke.thin });
  const text = makeText(label);
  text.x = 8;
  text.y = 2;
  container.addChild(bg, text);
  container.on("pointerdown", () => onClick());
  return container;
}

interface FormattableEvent {
  type: string;
}

function formatEvent(e: unknown): string {
  return (e as FormattableEvent).type;
}
