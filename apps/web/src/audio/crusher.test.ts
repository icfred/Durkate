import { describe, expect, it } from "vitest";
import { createCrusher } from "./crusher.js";

interface FakeNode {
  connections: FakeNode[];
  disconnected: boolean;
  gain?: { value: number };
  type?: string;
  frequency?: { value: number };
  Q?: { value: number };
  curve?: Float32Array | null;
  oversample?: string;
  onaudioprocess?: ((event: unknown) => void) | null;
  buffer?: { getChannelData(c: number): Float32Array } | null;
  loop?: boolean;
  started?: boolean;
}

function makeNode(extra: Partial<FakeNode> = {}): FakeNode {
  const node: FakeNode = {
    connections: [],
    disconnected: false,
    ...extra,
  };
  return node;
}

function makeCtx(opts: { withScript?: boolean; withBuffer?: boolean } = {}): {
  ctx: AudioContext;
  destination: FakeNode;
  counts: Record<string, number>;
} {
  const counts = {
    gain: 0,
    biquad: 0,
    shaper: 0,
    script: 0,
    buffer: 0,
    bufferSource: 0,
  };
  const destination = makeNode();

  const fakeCtx: Record<string, unknown> = {
    sampleRate: 48000,
    destination,
    createGain(): FakeNode {
      counts.gain += 1;
      const node = makeNode({ gain: { value: 1 } });
      attachConnect(node);
      return node;
    },
    createBiquadFilter(): FakeNode {
      counts.biquad += 1;
      const node = makeNode({
        type: "allpass",
        frequency: { value: 0 },
        Q: { value: 0 },
      });
      attachConnect(node);
      return node;
    },
    createWaveShaper(): FakeNode {
      counts.shaper += 1;
      const node = makeNode({ curve: null, oversample: "none" });
      attachConnect(node);
      return node;
    },
  };

  if (opts.withScript !== false) {
    fakeCtx.createScriptProcessor = (): FakeNode => {
      counts.script += 1;
      const node = makeNode({ onaudioprocess: null });
      attachConnect(node);
      return node;
    };
  }

  if (opts.withBuffer !== false) {
    fakeCtx.createBuffer = (_c: number, length: number): { getChannelData: () => Float32Array } => {
      counts.buffer += 1;
      return { getChannelData: () => new Float32Array(length) };
    };
    fakeCtx.createBufferSource = (): FakeNode => {
      counts.bufferSource += 1;
      const node = makeNode({ buffer: null, loop: false, started: false });
      attachConnect(node);
      const startable = node as FakeNode & { start(t: number): void; stop(): void };
      startable.start = (): void => {
        startable.started = true;
      };
      startable.stop = (): void => {};
      return node;
    };
  }

  return {
    ctx: fakeCtx as unknown as AudioContext,
    destination,
    counts,
  };
}

function attachConnect(node: FakeNode): void {
  (node as unknown as { connect: (target: FakeNode) => void }).connect = (target) => {
    node.connections.push(target);
  };
  (node as unknown as { disconnect: () => void }).disconnect = (): void => {
    node.disconnected = true;
  };
}

describe("createCrusher", () => {
  it("constructs without errors with default params", () => {
    const { ctx, destination, counts } = makeCtx();
    const crusher = createCrusher(ctx, destination as unknown as AudioNode);
    expect(crusher.input).toBeDefined();
    expect(counts.biquad).toBe(1);
    expect(counts.shaper).toBe(1);
    expect(counts.script).toBe(1);
  });

  it("connects input through filter -> shaper -> bitcrush -> output -> destination", () => {
    const { ctx, destination } = makeCtx();
    const crusher = createCrusher(ctx, destination as unknown as AudioNode);
    const input = crusher.input as unknown as FakeNode;
    expect(input.connections.length).toBe(1);
    // walk forward and confirm we reach the destination
    let cursor: FakeNode | undefined = input;
    let hops = 0;
    while (cursor && cursor !== destination && hops < 10) {
      cursor = cursor.connections[0];
      hops += 1;
    }
    expect(cursor).toBe(destination);
  });

  it("skips bitcrush when ScriptProcessor is unavailable", () => {
    const { ctx, destination, counts } = makeCtx({ withScript: false });
    expect(() => createCrusher(ctx, destination as unknown as AudioNode)).not.toThrow();
    expect(counts.script).toBe(0);
  });

  it("emits a noise source when noiseLevel > 0", () => {
    const { ctx, destination, counts } = makeCtx();
    createCrusher(ctx, destination as unknown as AudioNode, { noiseLevel: 0.05 });
    expect(counts.bufferSource).toBe(1);
    expect(counts.buffer).toBe(1);
  });

  it("skips noise when noiseLevel is 0", () => {
    const { ctx, destination, counts } = makeCtx();
    createCrusher(ctx, destination as unknown as AudioNode, { noiseLevel: 0 });
    expect(counts.bufferSource).toBe(0);
  });

  it("dispose disconnects every node it created", () => {
    const { ctx, destination } = makeCtx();
    const crusher = createCrusher(ctx, destination as unknown as AudioNode, { noiseLevel: 0.05 });
    const input = crusher.input as unknown as FakeNode;
    crusher.dispose();
    expect(input.disconnected).toBe(true);
  });
});
