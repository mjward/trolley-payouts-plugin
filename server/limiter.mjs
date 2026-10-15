// Token bucket shared by all concurrent workers. Sustained `perMinute`; burst ≈ 5s worth (min 1, max 50).
export const MAX_RPM = 2000;
export const burstFor = rpm => Math.max(1, Math.min(50, Math.ceil(rpm / 12)));
export class TokenBucket {
  constructor({ perMinute = 45, burst, now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
    this.now = now; this.sleep = sleep; this.setRate(perMinute, burst); this.tokens = this.capacity; this.last = now();
    this.chain = Promise.resolve();
  }
  setRate(perMinute, burst) {
    if (!(perMinute > 0)) throw new Error("perMinute must be > 0");
    perMinute = Math.min(perMinute, MAX_RPM);
    this.perMinute = perMinute; this.ratePerMs = perMinute / 60000;
    this.capacity = Math.max(1, Math.min(burst ?? burstFor(perMinute), perMinute));
    if (this.tokens > this.capacity) this.tokens = this.capacity;
  }
  refill() { const t = this.now(); this.tokens = Math.min(this.capacity, this.tokens + (t - this.last) * this.ratePerMs); this.last = t; }
  waitMs() { this.refill(); return this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) / this.ratePerMs); }
  // Serialized so concurrent callers can't double-spend a token.
  take() {
    const run = async () => { for (let w = this.waitMs(); w > 0; w = this.waitMs()) await this.sleep(w); this.tokens -= 1; };
    const p = this.chain.then(run); this.chain = p.catch(() => {}); return p;
  }
}
// TROLLEY_RATE_LIMIT (requests/min) is the main name; TROLLEY_RATE_LIMIT_PER_MIN is an alias. The new name wins if both are set. Default 100.
export function envRateLimit(env = process.env) {
  for (const k of ["TROLLEY_RATE_LIMIT", "TROLLEY_RATE_LIMIT_PER_MIN"]) { const n = Number(env[k]); if (env[k] && Number.isFinite(n) && n > 0) return Math.min(n, MAX_RPM); }
  return 100;
}
export const DEFAULT_RPM = envRateLimit();
export const limiter = new TokenBucket({ perMinute: DEFAULT_RPM });
