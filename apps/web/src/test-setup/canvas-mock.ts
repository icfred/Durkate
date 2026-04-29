interface FakeContext {
  font: string;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  textBaseline: string;
  textAlign: string;
  globalAlpha: number;
  measureText(text: string): TextMetrics;
  fillText(): void;
  strokeText(): void;
  fillRect(): void;
  clearRect(): void;
  getImageData(): { data: Uint8ClampedArray; width: number; height: number };
  putImageData(): void;
  drawImage(): void;
  scale(): void;
  translate(): void;
  rotate(): void;
  save(): void;
  restore(): void;
  beginPath(): void;
  closePath(): void;
  moveTo(): void;
  lineTo(): void;
  arc(): void;
  fill(): void;
  stroke(): void;
}

function fakeMetrics(text: string): TextMetrics {
  const width = text.length * 8;
  return {
    width,
    actualBoundingBoxAscent: 12,
    actualBoundingBoxDescent: 4,
    actualBoundingBoxLeft: 0,
    actualBoundingBoxRight: width,
    fontBoundingBoxAscent: 14,
    fontBoundingBoxDescent: 4,
  } as TextMetrics;
}

function makeContext(): FakeContext {
  const noop = () => {};
  return {
    font: "10px sans-serif",
    fillStyle: "#000",
    strokeStyle: "#000",
    lineWidth: 1,
    textBaseline: "alphabetic",
    textAlign: "start",
    globalAlpha: 1,
    measureText: fakeMetrics,
    fillText: noop,
    strokeText: noop,
    fillRect: noop,
    clearRect: noop,
    getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    putImageData: noop,
    drawImage: noop,
    scale: noop,
    translate: noop,
    rotate: noop,
    save: noop,
    restore: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    fill: noop,
    stroke: noop,
  };
}

class FakeCanvasRenderingContext2D {}

if (typeof HTMLCanvasElement !== "undefined") {
  const proto = HTMLCanvasElement.prototype as unknown as {
    getContext: (kind: string) => FakeContext | null;
  };
  proto.getContext = function getContext(kind: string): FakeContext | null {
    if (kind === "2d") return makeContext();
    return null;
  };
}

const globalScope = globalThis as unknown as {
  CanvasRenderingContext2D?: typeof FakeCanvasRenderingContext2D;
};
if (typeof globalScope.CanvasRenderingContext2D === "undefined") {
  globalScope.CanvasRenderingContext2D = FakeCanvasRenderingContext2D;
}
