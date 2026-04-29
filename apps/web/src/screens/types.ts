import type { Container } from "pixi.js";

export interface Screen extends Container {
  layout(viewWidth: number, viewHeight: number): void;
  dispose(): void;
}
