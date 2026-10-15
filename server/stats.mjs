// payout_stats computed from the local SQLite store after an implicit refresh.
import { ToolError } from "./client.mjs";
import { aggregate, resolveRange } from "./agg.mjs";
import { openDb } from "./db.mjs";
import { refresh } from "./sync.mjs";

export function statsFromDb(db, a) {
  const { start, end, preset } = resolveRange(a);
  const groupBy = a.groupBy;
  if (groupBy && !["country", "payoutMethod", "currency", "status"].includes(groupBy)) throw new ToolError("groupBy must be country | payoutMethod | currency | status");
  const tags = a.batchTags ? (Array.isArray(a.batchTags) ? a.batchTags : String(a.batchTags).split(",")).map(s => s.trim()).filter(Boolean) : [];
  const tagSql = tags.map((_, i) => `AND EXISTS (SELECT 1 FROM json_each(b.tags) WHERE value = :t${i})`).join(" ");
  const params = { s: start.toISOString(), e: end.toISOString(), ...Object.fromEntries(tags.map((t, i) => [`t${i}`, t])) };
  const rows = db.prepare(`SELECT p.status, p.sourceAmount, p.sourceCurrency, p.payoutMethod, p.country
    FROM payments p JOIN batches b ON b.id = p.batchId
    WHERE coalesce(p.processedAt, p.createdAt) >= :s AND coalesce(p.processedAt, p.createdAt) < :e ${tagSql}`).all(params);
  return {
    range: { start: params.s, end: params.e, ...(preset ? { preset } : {}), dateField: "payment processedAt, else createdAt; end exclusive; UTC" },
    ...aggregate(rows, { groupBy }), ...(groupBy ? { groupBy } : {}),
    amountBasis: "sourceAmount/sourceCurrency (amount debited from the merchant)",
  };
}

export const payoutStatsTool = {
  name: "payout_stats",
  description: "Read-only. Aggregate payouts in a date range from the local store (refreshed first unless skipRefresh): counts and exact sourceAmount sums per status and currency, failed/returned rates (combinedFailRate over all payments in range; combinedFailRateSettled over processed+failed+returned), optional groupBy. Payment date = processedAt, else createdAt.",
  inputSchema: { type: "object", properties: {
    startDate: { type: "string", description: "ISO 8601, inclusive" }, endDate: { type: "string", description: "ISO 8601, exclusive" },
    preset: { enum: ["last_7_days", "last_30_days", "this_month", "last_month", "year_to_date"] },
    groupBy: { enum: ["country", "payoutMethod", "currency", "status"] },
    batchTags: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }], description: "Only batches having all these tags" },
    skipRefresh: { type: "boolean", description: "Use local data as-is (no Trolley calls)." },
    rateLimitPerMin: { type: "number", minimum: 1, maximum: 2000 }, concurrency: { type: "integer", minimum: 1, maximum: 20 } } },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async run(a = {}) {
    resolveRange(a); // validate before any network
    const t0 = Date.now();
    const { loadConfig } = await import("./config.mjs"); const live = !loadConfig().paymentCache;
    const db = live ? openDb({ memory: true }) : openDb();
    try {
      const sync = a.skipRefresh ? null : await refresh(a, { db });
      const out = statsFromDb(db, a);
      const last = db.prepare("SELECT value FROM meta WHERE key='lastSyncAt'").get();
      return { ...out, refresh: sync ? { callsMade: sync.callsMade, refetched: sync.refetched, checked: sync.checked, checkChanged: sync.checkChanged, elapsedMs: sync.elapsedMs, rateLimited429: sync.rateLimited429 } : "skipped",
        dataAsOf: last?.value ?? null, elapsedMs: Date.now() - t0 };
    } finally { db.close(); }
  },
};
