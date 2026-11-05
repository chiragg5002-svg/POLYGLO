/* Small in-memory fixed-window limiter (single-instance; swap for Redis if scaled out). */
const { tooMany } = require("./errors");

class RateLimiter {
  constructor({ windowMs = 60000, max }) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map();
  }
  check(key, max = this.max) {
    const now = Date.now();
    if (this.hits.size > 10000) for (const [k, v] of this.hits) if (now - v.start > this.windowMs) this.hits.delete(k);
    const e = this.hits.get(key);
    if (!e || now - e.start >= this.windowMs) { this.hits.set(key, { start: now, count: 1 }); return; }
    e.count += 1;
    if (e.count > max) throw tooMany("Rate limit exceeded.", Math.max(1, Math.ceil((e.start + this.windowMs - now) / 1000)));
  }
  // Only count (used for failed-auth tracking)
  hit(key) {
    const now = Date.now();
    const e = this.hits.get(key);
    if (!e || now - e.start >= this.windowMs) this.hits.set(key, { start: now, count: 1 });
    else e.count += 1;
  }
  blocked(key) {
    const e = this.hits.get(key);
    return Boolean(e && Date.now() - e.start < this.windowMs && e.count >= this.max);
  }
}

module.exports = { RateLimiter };
