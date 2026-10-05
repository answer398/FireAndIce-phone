/**
 * Fixed-window rate limiter for room operations (create / join / rejoin).
 *
 * In-memory, per key (client IP). Buckets are pruned lazily on an interval
 * so abandoned keys cannot accumulate. Returns the remaining retry delay so
 * the socket layer can surface it to the client.
 */
export class RateLimiter {
  constructor({ windowMs = 60_000, max = 20, sweepIntervalMs = 300_000 } = {}) {
    this.windowMs = windowMs;
    this.max = max;
    this.buckets = new Map(); // key -> { windowStart, count }
    this.sweeper = setInterval(() => this.#prune(), sweepIntervalMs);
    this.sweeper.unref?.();
  }

  /**
   * Record one operation for `key`. Returns { ok, retryAfterMs, remaining }.
   */
  consume(key) {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart >= this.windowMs) {
      bucket = { windowStart: now, count: 0 };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > this.max) {
      return { ok: false, retryAfterMs: this.windowMs - (now - bucket.windowStart), remaining: 0 };
    }
    return { ok: true, retryAfterMs: 0, remaining: this.max - bucket.count };
  }

  #prune() {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStart >= this.windowMs) this.buckets.delete(key);
    }
  }

  stop() {
    clearInterval(this.sweeper);
  }
}
