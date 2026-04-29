import { Container, Graphics } from "pixi.js";
import { color, radius, stroke } from "../tokens.js";

export interface PanelOptions {
  width: number;
  height: number;
  fill?: number;
  border?: number;
  borderWidth?: number;
  cornerRadius?: number;
}

export class Panel extends Container {
  private readonly bg: Graphics;
  private w: number;
  private h: number;
  private fill: number;
  private border: number;
  private borderWidth: number;
  private cornerRadius: number;

  constructor(options: PanelOptions) {
    super();
    this.w = options.width;
    this.h = options.height;
    this.fill = options.fill ?? color.bgRaised;
    this.border = options.border ?? color.border;
    this.borderWidth = options.borderWidth ?? stroke.base;
    this.cornerRadius = options.cornerRadius ?? radius.sm;
    this.bg = new Graphics();
    this.addChild(this.bg);
    this.redraw();
  }

  resize(width: number, height: number): void {
    this.w = width;
    this.h = height;
    this.redraw();
  }

  private redraw(): void {
    this.bg
      .clear()
      .roundRect(0, 0, this.w, this.h, this.cornerRadius)
      .fill({ color: this.fill })
      .stroke({ color: this.border, width: this.borderWidth, alignment: 0 });
  }
}
