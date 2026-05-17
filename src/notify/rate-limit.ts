// v0.6 P4 — in-memory rate limit for /notify/reply.
//
// 30 reqs/min/IP by default (BOM §P4 spec is "30 requests/min/IP — cheap
// in-memory; defense against brute-forcing correlation_ids"). The bucket is
// a rolling window of 60s. Memory cost is O(unique IPs in last 60s) — for a
// personal stavR that's bounded by ~3 (operator phone + watch + desk).

export interface RateLimiterOpts {
  /** Tokens per window. Default 30. */
  max?: number;
  /** Window length in ms. Default 60_000. */
  windowMs?: number;
  /** Clock override for tests. */
  now?: () => number;
}

interface Bucket {
  windowStart: number;
  count: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private lastSweep = 0;

  constructor(opts: RateLimiterOpts = {}) {
    this.max = opts.max ?? 30;
    this.windowMs = opts.windowMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Returns true if the request is within budget. Increments the bucket as a
   * side effect — call this exactly once per incoming request.
   */
  check(key: string): boolean {
    const t = this.now();
    this.maybeSweep(t);
    const b = this.buckets.get(key);
    if (!b || t - b.windowStart >= this.windowMs) {
      this.buckets.set(key, { windowStart: t, count: 1 });
      return true;
    }
    if (b.count >= this.max) return false;
    b.count++;
    return true;
  }

  /** Tests only — peek bucket without mutating. */
  countFor(key: string): number {
    return this.buckets.get(key)?.count ?? 0;
  }

  private maybeSweep(t: number): void {
    if (t - this.lastSweep < this.windowMs) return;
    this.lastSweep = t;
    for (const [k, b] of this.buckets) {
      if (t - b.windowStart >= this.windowMs) this.buckets.delete(k);
    }
  }
}
