export interface TokenBucketOpts {
  capacity: number;
  refillIntervalMs: number;
  now?: () => number;
}

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly refillRatePerMs: number;
  private readonly nowFn: () => number;

  constructor({ capacity, refillIntervalMs, now }: TokenBucketOpts) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new RangeError("capacity must be a positive number");
    }
    if (!Number.isFinite(refillIntervalMs) || refillIntervalMs <= 0) {
      throw new RangeError("refillIntervalMs must be a positive number");
    }
    this.capacity = capacity;
    this.refillRatePerMs = capacity / refillIntervalMs;
    this.nowFn = now ?? Date.now;
    this.tokens = capacity;
    this.lastRefill = this.nowFn();
  }

  tryConsume(): boolean {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  available(): number {
    this.refill();
    return this.tokens;
  }

  private refill(): void {
    const now = this.nowFn();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRatePerMs);
    this.lastRefill = now;
  }
}
