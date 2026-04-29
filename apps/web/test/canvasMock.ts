// happy-dom does not provide CanvasRenderingContext2D as a global; pixi.js does
// `instanceof CanvasRenderingContext2D` on the result of getContext("2d") to feature-detect,
// so we declare a minimal class for the check to succeed.
class FakeCanvasRenderingContext2D {}
(
  globalThis as { CanvasRenderingContext2D?: typeof FakeCanvasRenderingContext2D }
).CanvasRenderingContext2D ??= FakeCanvasRenderingContext2D;

type Ctx = CanvasRenderingContext2D & { font: string };

const TEXT_METRICS: TextMetrics = {
  width: 8,
  actualBoundingBoxLeft: 0,
  actualBoundingBoxRight: 8,
  actualBoundingBoxAscent: 8,
  actualBoundingBoxDescent: 2,
  fontBoundingBoxAscent: 10,
  fontBoundingBoxDescent: 2,
  alphabeticBaseline: 0,
  emHeightAscent: 0,
  emHeightDescent: 0,
  hangingBaseline: 0,
  ideographicBaseline: 0,
};

function makeContext(canvas: HTMLCanvasElement): Ctx {
  const noop = (): void => undefined;
  const ctx = Object.assign(new FakeCanvasRenderingContext2D(), {
    canvas,
    font: "10px sans-serif",
    fillStyle: "#000",
    strokeStyle: "#000",
    textBaseline: "alphabetic" as CanvasTextBaseline,
    textAlign: "start" as CanvasTextAlign,
    lineWidth: 1,
    globalAlpha: 1,
    measureText: () => TEXT_METRICS,
    fillText: noop,
    strokeText: noop,
    fillRect: noop,
    strokeRect: noop,
    clearRect: noop,
    save: noop,
    restore: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    rect: noop,
    fill: noop,
    stroke: noop,
    translate: noop,
    rotate: noop,
    scale: noop,
    setTransform: noop,
    resetTransform: noop,
    drawImage: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createPattern: () => null,
    getImageData: () => ({
      data: new Uint8ClampedArray(4),
      width: 1,
      height: 1,
      colorSpace: "srgb",
    }),
    putImageData: noop,
    getContextAttributes: () => ({
      alpha: true,
      desynchronized: false,
      colorSpace: "srgb",
      willReadFrequently: false,
    }),
    isPointInPath: () => false,
    isPointInStroke: () => false,
  });
  return ctx as unknown as Ctx;
}

const original = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function getContext(
  this: HTMLCanvasElement,
  kind: string,
) {
  if (kind === "2d") return makeContext(this);
  // biome-ignore lint/suspicious/noExplicitAny: passthrough preserves original signature
  return (original as any)?.call(this, kind) ?? null;
} as typeof HTMLCanvasElement.prototype.getContext;
