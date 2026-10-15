// Pure aggregation helpers (exact decimal money, ranges, rates). No I/O.
import { ToolError } from "./client.mjs";

export const PAYMENT_STATUSES = ["pending", "processing", "processed", "failed", "returned"]; // per docs "List of Statuses"
export const TERMINAL = new Set(["processed", "failed", "returned"]);

// Exact decimal money: amounts are strings like "1.99" or "123". Sum in integer minor units (scale 1e6 to be safe).
const SCALE = 1000000n;
export function toMicros(s) {
  const m = /^(-?)(\d*)(?:\.(\d+))?$/.exec(String(s ?? "0").trim());
  if (!m) return 0n;
  const frac = (m[3] || "").padEnd(6, "0").slice(0, 6);
  const v = BigInt(m[2] || "0") * SCALE + BigInt(frac || "0");
  return m[1] ? -v : v;
}
export function fromMicros(v) {
  const neg = v < 0n; if (neg) v = -v;
  const i = v / SCALE, f = (v % SCALE).toString().padStart(6, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${i}.${f.padEnd(2, "0")}`;
}

export function resolveRange({ startDate, endDate, preset }, now = new Date()) {
  const day = 86400000;
  const utcMidnight = d => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  if (preset) {
    const t = utcMidnight(now);
    switch (preset) {
      case "last_7_days": return { start: new Date(t - 7 * day), end: t, preset };
      case "last_30_days": return { start: new Date(t - 30 * day), end: t, preset };
      case "this_month": return { start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), end: now, preset };
      case "last_month": return { start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)), end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), preset };
      case "year_to_date": return { start: new Date(Date.UTC(now.getUTCFullYear(), 0, 1)), end: now, preset };
      default: throw new ToolError(`Unknown preset '${preset}'. Use last_7_days, last_30_days, this_month, last_month, year_to_date.`);
    }
  }
  if (!startDate || !endDate) throw new ToolError("Provide startDate and endDate (ISO 8601), or a preset.");
  const start = new Date(startDate), end = new Date(endDate);
  if (isNaN(start) || isNaN(end)) throw new ToolError("startDate/endDate must be ISO 8601 dates.");
  if (end <= start) throw new ToolError("endDate must be after startDate.");
  return { start, end };
}

// A payment's own date: processedAt if set, else createdAt.
export const paymentDate = p => p.processedAt || p.createdAt || null;

const groupKey = (p, by) => {
  switch (by) {
    case "country": return p.country || p.recipient?.address?.country || p.recipient?.country || p.account?.country || "unknown";
    case "payoutMethod": return p.payoutMethod || p.recipient?.payoutMethod || "unknown";
    case "currency": return p.sourceCurrency || "unknown";
    case "status": return p.status || "unknown";
    default: return null;
  }
};

const rate = (num, den) => (den ? Math.round((num / den) * 10000) / 10000 : null);

export function aggregate(payments, { groupBy } = {}) {
  const mk = () => ({ count: 0, statuses: {}, amounts: {} });
  const add = (bucket, p) => {
    const st = p.status || "unknown", cur = p.sourceCurrency || "unknown";
    bucket.count++;
    bucket.statuses[st] = (bucket.statuses[st] || 0) + 1;
    bucket.amounts[st] ??= {}; bucket.amounts[st][cur] = (bucket.amounts[st][cur] || 0n) + toMicros(p.sourceAmount);
  };
  const total = mk(), groups = {};
  for (const p of payments) { add(total, p); if (groupBy) add(groups[groupKey(p, groupBy)] ??= mk(), p); }
  const finish = b => {
    const n = s => b.statuses[s] || 0;
    const settled = [...TERMINAL].reduce((a, s) => a + n(s), 0);
    const amounts = Object.fromEntries(Object.entries(b.amounts).map(([s, c]) => [s, Object.fromEntries(Object.entries(c).map(([k, v]) => [k, fromMicros(v)]))]));
    return {
      total: b.count, byStatus: b.statuses, amountsByStatus: amounts,
      rates: {
        failedRate: rate(n("failed"), b.count), returnedRate: rate(n("returned"), b.count),
        combinedFailRate: rate(n("failed") + n("returned"), b.count),
        combinedFailRateSettled: rate(n("failed") + n("returned"), settled),
        denominators: { all: b.count, settled, settledDefinition: "processed + failed + returned (excludes pending/processing)" },
      },
    };
  };
  const out = finish(total);
  if (groupBy) out.groups = Object.fromEntries(Object.entries(groups).sort((a, b) => b[1].count - a[1].count).map(([k, v]) => [k, finish(v)]));
  return out;
}

