// Recipient cache: lazy fill by id, watermark sweep, full backfill (/init). Read-only toward Trolley (GET only), shared rate limiter.
import { request } from "./client.mjs";
import { openDb, getState, setState, upsertRecipient } from "./db.mjs";
import { mkCtx, listAll, refresh, DEFAULT_CONCURRENCY } from "./sync.mjs";
import { runPool } from "./pool.mjs";

export const WATERMARK = "recipients.updatedAtWatermark";
export const OVERLAP_MS = 2 * 60 * 1000;

export const missingRecipientIds = (db, limit = -1) =>
  db.prepare("SELECT DISTINCT p.recipientId id FROM payments p LEFT JOIN recipients r ON r.id=p.recipientId WHERE p.recipientId IS NOT NULL AND r.id IS NULL LIMIT ?").all(limit).map(x => x.id);

// Temporary errors worth retrying: rate limits, 5xx, timeouts, network drops. 4xx (403, 400, ...) and 404 are permanent.
export const isTransient = e => /HTTP (429|5\d\d)\b|rate limited|timed? ?out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|network error|fetch failed|aborted/i.test(e?.message || String(e));
export const RETRIES = Number(process.env.TROLLEY_RECIPIENT_RETRIES ?? 2);
export const RETRY_WAIT_MS = Number(process.env.TROLLEY_RETRY_WAIT_MS ?? 2000);
const sleepMs = ms => new Promise(r => setTimeout(r, ms));

// For each payment recipientId missing from the table: GET /recipients/:id and upsert it. A 404 becomes a stub row (status not_found) so it isn't retried forever.
// Temporary errors are retried up to `retries` more times, waiting retryWaitMs * attempt between tries. Failures are returned with their reason.
export async function lazyFill(db, { get = request, ctx = mkCtx(DEFAULT_CONCURRENCY), limit = -1, onProgress, retries = RETRIES, retryWaitMs = RETRY_WAIT_MS, sleep = sleepMs } = {}) {
  const ids = missingRecipientIds(db, limit); let done = 0, notFound = 0; const failures = [];
  await runPool(ids, async id => {
    for (let attempt = 0; ; attempt++) {
      try { const r = (await get("GET", `/recipients/${encodeURIComponent(id)}`, ctx.opts)).recipient; if (r) upsertRecipient(db, r); break; }
      catch (e) {
        if (/HTTP 404|not_found/.test(e.message)) { upsertRecipient(db, { id, status: "not_found" }); notFound++; break; }
        if (attempt < retries && isTransient(e)) { await sleep(retryWaitMs * (attempt + 1)); continue; }
        failures.push({ id, reason: String(e?.message || e).slice(0, 300), transient: isTransient(e), attempts: attempt + 1 }); break;
      }
    }
    if (++done % 250 === 0) onProgress?.({ done, total: ids.length });
  }, ctx);
  return { missing: ids.length, filled: done - failures.length - notFound, notFound, failed: failures.length, failures };
}

// Bulk fill: list every recipient (pageSize 1000) and keep only IDs referenced by cached payments. Same stored fields as the per-ID
// fill (name never stored). Resumable: completed pages are kept in sync_state.
export const BULK_PAGE = 1000;
export async function bulkFill(db, { get = request, ctx = mkCtx(DEFAULT_CONCURRENCY), onProgress, stateKey = "backfill.recipientPagesDone" } = {}) {
  const want = new Set(missingRecipientIds(db));
  if (!want.size) return { strategy: "bulk", missing: 0, filled: 0, pages: 0 };
  const done = new Set(JSON.parse(getState(db, stateKey) || "[]"));
  const page = async n => (await get("GET", "/recipients", { query: { page: n, pageSize: BULK_PAGE }, ...ctx.opts }));
  const first = done.has(1) ? null : await page(1);
  const pages = first?.meta?.pages ?? (Number(getState(db, stateKey + ".total")) || 1);
  setState(db, stateKey + ".total", pages);
  let filled = 0;
  const take = (n, list) => { db.exec("BEGIN"); try { for (const r of list || []) if (want.has(r.id)) { upsertRecipient(db, r); want.delete(r.id); filled++; } done.add(n); setState(db, stateKey, JSON.stringify([...done])); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; } onProgress?.({ done: done.size, total: pages, filled }); };
  if (first) take(1, first.recipients);
  await runPool(Array.from({ length: pages }, (_, i) => i + 1).filter(n => !done.has(n)), async n => take(n, (await page(n)).recipients), ctx);
  return { strategy: "bulk", pages, filled, leftover: want.size };
}
// Choose a strategy: per-ID costs one call per missing recipient; bulk costs ceil(total/1000) calls, each slower.
export const BULK_COST_FACTOR = 25; // measured: a 1000-row page is ~25x a single GET by ID (assumption; tune via TROLLEY_BULK_COST_FACTOR)
export function chooseStrategy(missing, totalRecipients, factor = Number(process.env.TROLLEY_BULK_COST_FACTOR) || BULK_COST_FACTOR) {
  const bulkCalls = Math.ceil(totalRecipients / BULK_PAGE);
  return { strategy: totalRecipients > 0 && bulkCalls * factor < missing ? "bulk" : "per-id", bulkCalls, perIdCalls: missing };
}

// Sweep: refresh known recipients changed since the watermark. Fetch everything first, then upsert + advance in one transaction.
// Any failure throws before the transaction, so the watermark stays put.
export async function sweepRecipients(db, { get = request, ctx = mkCtx(DEFAULT_CONCURRENCY), now = new Date(), dryRun = false } = {}) {
  const wm = getState(db, WATERMARK), sweepStart = now.toISOString();
  if (!wm) { if (!dryRun) setState(db, WATERMARK, sweepStart); return { firstRun: true, watermark: sweepStart, fetched: 0, updated: 0 }; }
  const startDate = new Date(Date.parse(wm) - OVERLAP_MS).toISOString();
  const rows = await listAll("/recipients", "recipients", { query: { startDate, endDate: sweepStart, orderBy: "updatedAt", sortBy: "asc" }, ctx, get, pageSize: 1000 });
  const latest = new Map(); // overlap and page-shift duplicates: keep the newest per id
  for (const r of rows) { const p = latest.get(r.id); if (!p || String(r.updatedAt ?? "") > String(p.updatedAt ?? "")) latest.set(r.id, r); }
  const known = db.prepare("SELECT 1 FROM recipients WHERE id=?");
  let updated = 0, maxUpdated = null;
  if (dryRun) { // read-only: count what would change, write nothing
    for (const r of latest.values()) { if (r.updatedAt && (!maxUpdated || r.updatedAt > maxUpdated)) maxUpdated = r.updatedAt; if (known.get(r.id)) updated++; }
    return { dryRun: true, firstRun: false, from: startDate, to: sweepStart, fetched: rows.length, distinct: latest.size, wouldUpdate: updated, watermark: wm, wouldAdvanceTo: latest.size ? (maxUpdated && maxUpdated > wm ? maxUpdated : wm) : sweepStart };
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const r of latest.values()) {
      if (r.updatedAt && (!maxUpdated || r.updatedAt > maxUpdated)) maxUpdated = r.updatedAt;
      if (known.get(r.id)) { upsertRecipient(db, r); updated++; }
    }
    const next = latest.size ? (maxUpdated && maxUpdated > wm ? maxUpdated : wm) : sweepStart;
    setState(db, WATERMARK, next);
    db.exec("COMMIT");
    return { firstRun: false, from: startDate, to: sweepStart, fetched: rows.length, distinct: latest.size, updated, watermark: next };
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

// Full backfill (/init): every batch and payment (with recipientId), then each referenced recipient, then the watermark goes to the
// backfill start. Idempotent and resumable: synced batches are skipped by the refresh plan, filled recipients aren't refetched, and the
// start time is kept in sync_state until completion.
export async function backfill({ get = request, db: dbIn, log = m => process.stderr.write(m + "\n"), concurrency = DEFAULT_CONCURRENCY, cfg } = {}) {
  cfg ??= (await import("./config.mjs")).loadConfig();
  if (!cfg.syncEnabled) { log("sync disabled (TROLLEY_SYNC_ENABLED off): backfill skipped."); return { complete: false, skipped: true, status: "sync disabled" }; }
  if (!cfg.paymentCache && !cfg.recipientCache) { log("Both caches are disabled: nothing to backfill."); return { complete: false, skipped: true, status: "caches disabled" }; }
  const db = dbIn ?? openDb();
  try {
    let start = getState(db, "backfill.startedAt");
    if (!start || getState(db, "backfill.completedAt")) { start = new Date().toISOString(); setState(db, "backfill.startedAt", start); setState(db, "backfill.completedAt", null); }
    else log(`Resuming backfill started ${start} (phase ${getState(db, "backfill.phase")})`);
    if (!cfg.paymentCache) { log("payment cache disabled: no batches/payments to backfill, and so no recipients to fill (lazy fill needs cached payments)."); return { complete: false, skipped: true, status: "payment cache disabled" }; }
    setState(db, "backfill.phase", "batches"); log("Phase 1/3: batches and payments (with recipientId)…");
    const t1 = Date.now();
    const hb = heartbeat(log);
    hb.log("  listing batches…", () => `  listing batches… ${fmtDur((Date.now() - t1) / 1000)} elapsed`);
    let b;
    try {
      b = await refresh({ concurrency }, { get, db, onProgress: p => {
        if (p.type === "batch") setState(db, "backfill.batchesDone", p.done);
        const make = () => progressLine(p, (Date.now() - t1) / 1000);
        hb.log(make(), make);
      } });
    } finally { hb.stop(); }
    log(`  done: ${b.dbBatches} batches, ${b.dbPayments} payments, ${b.callsMade} calls, ${Math.round((Date.now() - t1) / 1000)}s${b.complete ? "" : `, ${b.failedBatches} batches failed (re-run to retry)`}`);
    if (!cfg.recipientCache) {
      if (b.complete) { setState(db, "backfill.completedAt", new Date().toISOString()); setState(db, "backfill.phase", "done"); }
      log("recipient cache disabled: skipping recipients and the watermark."); return { complete: b.complete, batches: b, recipients: "recipient cache disabled" };
    }
    setState(db, "backfill.phase", "recipients"); log("Phase 2/3: recipients referenced by payments…");
    const t2 = Date.now();
    const missing = missingRecipientIds(db).length;
    let total = 0; if (missing) { try { total = (await get("GET", "/recipients", { query: { page: 1, pageSize: 1 } })).meta?.records ?? 0; } catch { total = 0; } } // unknown total: per-ID
    const plan = chooseStrategy(missing, total);
    log(`  ${missing} distinct recipient IDs on cached payments; ${total} recipients in Trolley. Strategy: ${plan.strategy} (${plan.strategy === "bulk" ? plan.bulkCalls + " page calls" : missing + " ID calls"}).`);
    if (plan.strategy === "bulk") try { const bf = await bulkFill(db, { get, ctx: mkCtx(concurrency), onProgress: p => log(`  pages ${p.done}/${p.total}, ${p.filled} kept, ${Math.round((Date.now() - t2) / 1000)}s`) }); log(`  bulk: ${bf.filled} kept, ${bf.leftover} not listed (fetched by ID next)`); } catch (e) { log(`  bulk listing stopped (${e.message}); completed pages are saved. Continuing per ID; re-run to resume bulk.`); }
    const r = await lazyFill(db, { get, ctx: mkCtx(concurrency), onProgress: p => { setState(db, "backfill.recipientsDone", p.done); log(`  recipients ${p.done}/${p.total}, ${Math.round((Date.now() - t2) / 1000)}s`); } });
    log(`  done: ${r.filled} filled, ${r.notFound} not found, ${r.failed} failed`);
    for (const f of r.failures.slice(0, 50)) log(`  failed ${f.id} after ${f.attempts} attempt(s)${f.transient ? " (temporary)" : " (permanent, not retried)"}: ${f.reason}`);
    if (r.failures.length > 50) log(`  …and ${r.failures.length - 50} more failures`);
    if (!b.complete || r.failed) { log("Incomplete: re-run to resume. Watermark not set."); return { complete: false, batches: b, recipients: r }; }
    setState(db, WATERMARK, start); setState(db, "backfill.completedAt", new Date().toISOString()); setState(db, "backfill.phase", "done");
    log(`Phase 3/3: recipient watermark set to ${start}. Backfill complete.`);
    return { complete: true, batches: b, recipients: r, watermark: start };
  } finally { if (!dbIn) db.close(); }
}

// Backfill progress formatting (pure, for tests). ETA from payment throughput so far; "?" until there's data.
export const fmtDur = s => (s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);
export function progressLine(e, elapsedS) {
  const rate = e.fetched > 0 && elapsedS > 0 ? e.fetched / elapsedS : 0;
  const left = Math.max(0, (e.expected || 0) - (e.fetched || 0));
  const eta = rate ? fmtDur(left / rate) : "?";
  if (e.type === "batch") return `  batch done ${e.done}/${e.total} (${e.batchId}, ${e.plan}${e.payments ? `, ${e.payments} payments` : ""}) | ${e.fetched} payments stored | ${fmtDur(elapsedS)} elapsed | ETA ${eta}`;
  return `  batch ${e.batchIndex}/${e.total} page ${e.page}/${e.pages} | ${e.fetched} payments stored${e.expected ? ` of ~${e.expected} queued` : ""} | ${fmtDur(elapsedS)} elapsed | ETA ${eta}`;
}
// Heartbeat: re-print the latest status if nothing was logged for `everyMs`, so slow pages never look stuck.
export function heartbeat(log, everyMs = 15000, now = () => Date.now()) {
  let last = now(), latest = null;
  const t = setInterval(() => { if (latest && now() - last >= everyMs) { log(latest() + " (waiting on Trolley…)"); last = now(); } }, Math.min(everyMs, 5000));
  t.unref?.();
  return { log: (line, fn) => { log(line); last = now(); latest = fn; }, stop: () => clearInterval(t) };
}

export const recipientCache = db => ({
  get: id => { const r = db.prepare("SELECT * FROM recipients WHERE id=?").get(id); return r ? { ...r, isPhoneVerified: r.isPhoneVerified == null ? null : !!r.isPhoneVerified } : null; },
  put: r => upsertRecipient(db, r),
});
