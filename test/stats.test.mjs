process.env.TROLLEY_CONFIG_FILE ??= "/nonexistent/trolley-test-config.json"; // isolate from the machine config
import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate, toMicros, fromMicros, resolveRange, paymentDate } from "../server/agg.mjs";
import { TokenBucket } from "../server/limiter.mjs";

const P = (status, amt, cur = "USD", extra = {}) => ({ status, sourceAmount: amt, sourceCurrency: cur, ...extra });

test("exact decimal sums", () => {
  assert.equal(fromMicros(toMicros("0.10") + toMicros("0.20")), "0.30");
  assert.equal(fromMicros(toMicros("123") + toMicros("1.99")), "124.99");
  assert.equal(fromMicros(0n), "0.00");
});
test("counts, failed vs returned separate, rates and denominators", () => {
  const ps = [P("processed", "10.00"), P("processed", "5.50"), P("failed", "1.00"), P("returned", "2.00", "CAD"), P("pending", "3.00"), P("processing", "4.00")];
  const a = aggregate(ps);
  assert.equal(a.total, 6);
  assert.deepEqual(a.byStatus, { processed: 2, failed: 1, returned: 1, pending: 1, processing: 1 });
  assert.deepEqual(a.amountsByStatus.processed, { USD: "15.50" });
  assert.deepEqual(a.amountsByStatus.returned, { CAD: "2.00" });
  assert.equal(a.rates.failedRate, 0.1667);
  assert.equal(a.rates.returnedRate, 0.1667);
  assert.equal(a.rates.combinedFailRate, 0.3333);      // 2/6
  assert.equal(a.rates.denominators.settled, 4);
  assert.equal(a.rates.combinedFailRateSettled, 0.5);  // 2/4
});
test("empty input gives null rates", () => {
  const a = aggregate([]); assert.equal(a.total, 0); assert.equal(a.rates.combinedFailRate, null);
});
test("groupBy currency / payoutMethod / country", () => {
  const ps = [P("processed", "1", "USD", { payoutMethod: "paypal" }), P("failed", "1", "EUR", { payoutMethod: "bank-transfer", recipient: { address: { country: "DE" } } })];
  assert.deepEqual(Object.keys(aggregate(ps, { groupBy: "currency" }).groups).sort(), ["EUR", "USD"]);
  assert.equal(aggregate(ps, { groupBy: "payoutMethod" }).groups["bank-transfer"].rates.combinedFailRate, 1);
  assert.deepEqual(Object.keys(aggregate(ps, { groupBy: "country" }).groups).sort(), ["DE", "unknown"]);
});
test("ranges and payment date", () => {
  const now = new Date("2026-10-15T09:00:00Z");
  const lm = resolveRange({ preset: "last_month" }, now);
  assert.equal(lm.start.toISOString(), "2026-09-01T00:00:00.000Z"); assert.equal(lm.end.toISOString(), "2026-10-01T00:00:00.000Z");
  const jan = resolveRange({ preset: "last_month" }, new Date("2026-01-10T00:00:00Z"));
  assert.equal(jan.start.toISOString(), "2025-12-01T00:00:00.000Z");
  assert.equal(resolveRange({ preset: "last_7_days" }, now).start.toISOString(), "2026-10-08T00:00:00.000Z");
  assert.throws(() => resolveRange({ startDate: "2026-02-01", endDate: "2026-01-01" }), /after/);
  assert.equal(paymentDate({ processedAt: null, createdAt: "c" }), "c");
  assert.equal(paymentDate({ processedAt: "p", createdAt: "c" }), "p");
});
test("token bucket: burst then sustained rate", async () => {
  let t = 0; const slept = [];
  const b = new TokenBucket({ perMinute: 60, burst: 3, now: () => t, sleep: async ms => { slept.push(ms); t += ms; } });
  for (let i = 0; i < 3; i++) await b.take();
  assert.equal(slept.length, 0);                 // burst of 3 is free
  await b.take(); await b.take();
  assert.deepEqual(slept, [1000, 1000]);          // then 1/sec at 60/min
  // 63 requests in total should take ~60s of virtual time
  for (let i = 0; i < 58; i++) await b.take();
  assert.ok(t >= 59000 && t <= 61000, String(t));
});
test("token bucket validates rate", () => { assert.throws(() => new TokenBucket({ perMinute: 0 })); });
