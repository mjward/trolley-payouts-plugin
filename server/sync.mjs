// Refresh the local SQLite store from Trolley. GET-only toward Trolley.
import { request } from "./client.mjs";
import { limiter, DEFAULT_RPM, MAX_RPM } from "./limiter.mjs";
import { runPool } from "./pool.mjs";
import { openDb, upsertBatchMeta, replaceBatchPayments, deleteMissingBatches } from "./db.mjs";

export const TERMINAL_BATCH = new Set(["complete", "failed"]);
const envDays = Number(process.env.TROLLEY_FINAL_AFTER_DAYS);
export const FINAL_AFTER_DAYS = Number.isFinite(envDays) && envDays > 0 ? envDays : 120;
const envConc = Number(process.env.TROLLEY_CONCURRENCY);
export const MAX_CONCURRENCY = 20;
export const DEFAULT_CONCURRENCY = Number.isFinite(envConc) && envConc >= 1 ? Math.min(Math.floor(envConc), MAX_CONCURRENCY) : 4;

export function mkCtx(concurrency) {
  const ctx = { calls: 0, n429: 0, concurrency };
  ctx.opts = { onCall: () => ctx.calls++, on429: () => { ctx.n429++; if (ctx.n429 % 2 === 0 && ctx.concurrency > 1) ctx.concurrency = Math.max(1, Math.floor(ctx.concurrency / 2)); } };
  return ctx;
}
// Payment pages: Trolley's response time scales with page size (prod, Oct 2026, processing batch: 10→1s, 100→29s, 1000→>3min),
// so payment listings use TROLLEY_PAGE_SIZE (default 100) and fan out. Batch listings stay at 1000.
const envPs = Number(process.env.TROLLEY_PAGE_SIZE);
export const PAYMENT_PAGE_SIZE = Number.isInteger(envPs) && envPs >= 10 && envPs <= 1000 ? envPs : 100;
export async function listAll(path, key, { query = {}, ctx, get = request, pageSize = key === "payments" ? PAYMENT_PAGE_SIZE : 1000, onPage }) {
  let pagesTotal = 1;
  const fetchPage = async page => { const r = await get("GET", path, { query: { ...query, page, pageSize }, ...ctx.opts }); pagesTotal = r.meta?.pages ?? pagesTotal; onPage?.({ page, pages: pagesTotal, rows: (r[key] || []).length }); return r; };
  const first = await fetchPage(1); const pages = first.meta?.pages ?? 1; const byPage = { 1: first[key] || [] };
  await runPool(Array.from({ length: Math.max(0, pages - 1) }, (_, k) => k + 2), async pg => { byPage[pg] = (await fetchPage(pg))[key] || []; }, ctx);
  const items = []; for (let pg = 1; pg <= pages; pg++) items.push(...byPage[pg]); return items;
}

// Decide what to do with one batch. Pure, for unit tests.
export function planBatch(b, stored, { now = Date.now(), finalAfterDays = FINAL_AFTER_DAYS, full = false, force = false } = {}) {
  if (force) return "refetch";
  if (!b.totalPayments) return stored?.lastSyncedAt && stored.updatedAt === b.updatedAt ? "skip" : "meta";
  if (!TERMINAL_BATCH.has(b.status)) return "refetch";                       // non-terminal: always
  if (!stored?.lastSyncedAt) return "refetch";                               // never synced
  if (stored.updatedAt !== b.updatedAt || stored.status !== b.status) return "refetch";
  const doneAt = Date.parse(b.completedAt || b.updatedAt || 0);
  if (now - doneAt < finalAfterDays * 864e5 || full) return "check";        // late returns possible: cheap check
  return "skip";                                                             // old terminal: final
}

export async function refresh(a = {}, { get = request, db: dbIn, onProgress } = {}) {
  const t0 = Date.now();
  limiter.setRate(Math.min(a.rateLimitPerMin ?? DEFAULT_RPM, MAX_RPM));
  const ctx = mkCtx(Math.max(1, Math.min(Math.floor(a.concurrency ?? DEFAULT_CONCURRENCY), MAX_CONCURRENCY)));
  const db = dbIn ?? openDb();
  const failures = [];
  const counts = { batchesListed: 0, refetched: 0, checked: 0, checkChanged: 0, skipped: 0, metaOnly: 0, removed: 0, paymentsUpserted: 0 };
  try {
    const batches = await listAll("/batches", "batches", { ctx, get });
    counts.batchesListed = batches.length;
    const getStored = db.prepare("SELECT updatedAt, status, returnedCount, lastSyncedAt FROM batches WHERE id=?");
    // Batches whose payments were stored before payments.recipientId existed get one refetch to backfill it.
    const needRecipient = new Set(db.prepare("SELECT DISTINCT batchId id FROM payments WHERE recipientId IS NULL").all().map(x => x.id));
    // Progress events (for the backfill CLI): one per payments page and one per finished batch.
    const prog = { done: 0, total: batches.length, fetched: 0, expected: 0, started: 0 };
    const tick = (b, plan, payments) => { prog.done++; onProgress?.({ type: "batch", ...prog, batchId: b.id, plan, payments }); };
    const refetch = async (b, returnedCount) => {
      const idx = ++prog.started; prog.expected += b.totalPayments || 0;
      const ps = await listAll(`/batches/${encodeURIComponent(b.id)}/payments`, "payments", { ctx, get,
        onPage: p => { prog.fetched += p.rows; onProgress?.({ type: "page", ...prog, batchIndex: idx, batchId: b.id, page: p.page, pages: p.pages }); } });
      replaceBatchPayments(db, b, ps, { returnedCount }); counts.refetched++; counts.paymentsUpserted += ps.length;
    };
    await runPool(batches, async b => { let plan = "?", n = 0; try {
      plan = needRecipient.has(b.id) ? "refetch" : planBatch(b, getStored.get(b.id), { full: a.full, force: a.force });
      if (plan === "refetch") { await refetch(b); n = b.totalPayments || 0; return; }
      if (plan === "meta") { replaceBatchPayments(db, b, []); counts.metaOnly++; return; }
      if (plan === "skip") { counts.skipped++; return; }
      counts.checked++;
      const r = await get("GET", `/batches/${encodeURIComponent(b.id)}/payments`, { query: { status: "returned", page: 1, pageSize: 1 }, ...ctx.opts });
      const remote = r.meta?.records ?? (r.payments || []).length;
      if (remote !== getStored.get(b.id)?.returnedCount) { counts.checkChanged++; { plan = "refetch (new returns)"; return refetch(b, undefined); } }
      upsertBatchMeta(db, b); counts.skipped++;
    } catch (e) { failures.push({ batchId: b.id, error: String(e.message).slice(0, 160) }); } finally { tick(b, plan, n); } }, ctx);
    counts.removed = deleteMissingBatches(db, batches.map(b => b.id));
    counts.failedBatches = failures.length;
    db.prepare("INSERT INTO meta(key,value) VALUES('lastSyncAt',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(new Date().toISOString());
    db.secure?.();
    const tot = db.prepare("SELECT (SELECT count(*) FROM batches) b, (SELECT count(*) FROM payments) p").get();
    return { ...counts, dbBatches: Number(tot.b), dbPayments: Number(tot.p), callsMade: ctx.calls, rateLimited429: ctx.n429,
      concurrency: { final: ctx.concurrency }, rateLimitPerMin: limiter.perMinute, finalAfterDays: FINAL_AFTER_DAYS, complete: failures.length === 0,
      ...(failures.length ? { failures: failures.slice(0, 10), note: "Some batches failed after retries; they keep their previous data and will be retried on the next sync." } : {}), elapsedMs: Date.now() - t0 };
  } finally { if (!dbIn) db.close(); }
}

export const syncCacheTool = {
  name: "sync_cache",
  description: `Refresh the local SQLite store from Trolley (payments and batches hold no PII; recipients hold name and email only, by owner approval). scope: batches (default), recipients (watermark sweep) or all. For a full first-time backfill use /init (sh run.sh backfill). Read-only toward Trolley (GET only). Lists all batches; non-terminal batches are always refetched; terminal batches completed < ${FINAL_AFTER_DAYS} days ago (TROLLEY_FINAL_AFTER_DAYS) get a 1-call returned-count check and are refetched on change; older terminal batches are final after their first sync. full:true also checks old terminal batches; force:true refetches everything.`,
  inputSchema: { type: "object", properties: {
    scope: { type: "string", enum: ["batches", "recipients", "all"], description: "batches (default): batches + payments, then lazy-fill up to 500 missing recipients. recipients: watermark sweep of cached recipients + lazy-fill up to 500. all: both." },
    full: { type: "boolean" }, force: { type: "boolean" },
    rateLimitPerMin: { type: "number", minimum: 1, maximum: 2000 }, concurrency: { type: "integer", minimum: 1, maximum: 20 } } },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  run: async (a = {}) => {
    const { lazyFill, sweepRecipients } = await import("./recipients.mjs");
    const { loadConfig, SYNC_DISABLED } = await import("./config.mjs");
    const cfg = loadConfig();
    const scope = a.scope || "batches", out = { scope, config: { recipientCache: cfg.recipientCache, paymentCache: cfg.paymentCache, syncEnabled: cfg.syncEnabled } };
    if (!cfg.syncEnabled) return { ...out, ...SYNC_DISABLED };
    if (a.rateLimitPerMin) limiter.setRate(Math.min(a.rateLimitPerMin, MAX_RPM));
    if (scope !== "recipients") { if (cfg.paymentCache) Object.assign(out, await refresh(a)); else out.payouts = "payment cache disabled: not synced"; }
    if (!cfg.recipientCache) { out.recipients = "recipient cache disabled: no sweep, no lazy fill"; return out; }
    if (!cfg.paymentCache && scope === "batches") return out;
    const db = openDb();
    try {
      const ctx = mkCtx(Math.max(1, Math.min(Math.floor(a.concurrency ?? DEFAULT_CONCURRENCY), MAX_CONCURRENCY)));
      if (scope !== "batches") out.recipientSweep = await sweepRecipients(db, { ctx });
      if (cfg.paymentCache) out.recipientLazyFill = await lazyFill(db, { ctx, limit: 500 }); // recipientIds come from cached payments
      out.recipientsRemaining = db.prepare("SELECT count(DISTINCT p.recipientId) n FROM payments p LEFT JOIN recipients r ON r.id=p.recipientId WHERE p.recipientId IS NOT NULL AND r.id IS NULL").get().n;
      out.dbRecipients = db.prepare("SELECT count(*) n FROM recipients").get().n;
      if (out.recipientsRemaining) out.recipientNote = "More recipients to fill: run sync_cache again, or the full backfill (/init).";
    } finally { db.close(); }
    return out;
  },
};
