// Token-bucket rate limiter keyed by client address.
export class RateLimiter {
  constructor({ capacity = 60, refillPerSecond = 10, now = Date.now, maxKeys = 5000 } = {}) {
    this.capacity = capacity;
    this.refill = refillPerSecond;
    this.now = now;
    this.maxKeys = maxKeys;
    this.buckets = new Map();
  }

  /** @returns {boolean} true if the request may proceed */
  take(key, cost = 1) {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.buckets.delete(this.buckets.keys().next().value);
      b = { tokens: this.capacity, at: t };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.capacity, b.tokens + ((t - b.at) / 1000) * this.refill);
    b.at = t;
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  }
}
