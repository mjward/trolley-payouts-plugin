// Scheduled cache syncs (launchd). Pure API -> cache: GET only, no AI calls, no names, keys never printed.
//   payment-sync (hourly): payment-level updatedAt watermark via GET /v1/payments?orderBy=updatedAt&sortBy=desc, 2-min overlap,
//                          plus a returned sweep (status=returned on each batch created in the last 90 days) every 6 h.
//   recipient-sync (6-hourly): recipient updatedAt watermark (sweepRecipients), cached recipients only; skipped on payday-batch days.
import { openSync, closeSync, writeSync, readFileSync, unlinkSync, existsSync, statSync, renameSync, mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { request } from "./client.mjs";
import { openDb, dbPath, getState, setState, upsertBatchMeta, PAYMENT_COLS, toPaymentRow } from "./db.mjs";
import { sweepRecipients, OVERLAP_MS } from "./recipients.mjs";
import { loadConfig } from "./config.mjs";
import { paydayConfig, tzParts, clampDay, zonedMidnightUtc, inAnyGroup } from "./payday.mjs";

export const PAY_WM = "payments.updatedAtWatermark";
export const RETURNED_AT = "payments.returnedSweepAt";
export const RETURNED_EVERY_MS = 6 * 3600e3;
export const RETURNED_DAYS = 90;
export const PAGE = 100;
export const MAX_PAGES = Number(process.env.TROLLEY_SYNC_MAX_PAGES) || 1000;

// ---------- lock ----------
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
export const lockPath = (db = dbPath()) => join(dirname(db), "sync.lock");
// Exclusive create; a lock whose PID is gone is stale and removed. Returns a release fn, or null when held.
export function acquireLock(path, { pid = process.pid, label = "job", isAlive = alive } = {}) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(path, "wx", 0o600); writeSync(fd, JSON.stringify({ pid, label, at: new Date().toISOString() })); closeSync(fd);
      return () => { try { if (JSON.parse(readFileSync(path, "utf8")).pid === pid) unlinkSync(path); } catch {} };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let h; try { h = JSON.parse(readFileSync(path, "utf8")); } catch { h = null; }
      if (h && isAlive(h.pid)) return null;
      try { unlinkSync(path); } catch {}
    }
  }
  return null;
}
export const lockHolder = path => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } };
// Backfills started by older plugin versions don't take the lock, so look for the process too.
export function runningBackfill(ps = () => execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" })) {
  try { return ps().split("\n").map(l => l.trim().match(/^(\d+)\s+(.*)$/)).filter(m => m && /server\/backfill\.mjs/.test(m[2]) && Number(m[1]) !== process.pid).map(m => Number(m[1])); }
  catch { return []; }
}

// ---------- logs ----------
export const logDir = () => process.env.TROLLEY_LOG_DIR || join(homedir(), "Library", "Logs", "trolley-plugin");
export function rotate(file, { maxBytes = 1 << 20, keep = 5 } = {}) {
  try { if (statSync(file).size < maxBytes) return false; } catch { return false; }
  for (let i = keep - 1; i >= 1; i--) if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
  renameSync(file, `${file}.1`); return true;
}
export function mkLogger(name, dir = logDir()) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${name}.log`); rotate(file); rotate(join(dir, `${name}.launchd.log`));
  return m => appendFileSync(file, `${new Date().toISOString()} ${m}\n`, { mode: 0o600 });
}

// ---------- payments ----------
const UPSERT = `INSERT INTO payments(${PAYMENT_COLS.join(",")}) VALUES(${PAYMENT_COLS.map(c => ":" + c).join(",")})
  ON CONFLICT(id) DO UPDATE SET ${PAYMENT_COLS.filter(c => c !== "id").map(c => `${c}=excluded.${c}`).join(",")}`;
const batchIdOf = p => (typeof p.batch === "string" ? p.batch : p.batch?.id) ?? p.batchId ?? null;
const newest = rows => { const m = new Map(); for (const p of rows) { const o = m.get(p.id); if (!o || String(p.updatedAt ?? "") > String(o.updatedAt ?? "")) m.set(p.id, p); } return m; };

// Idempotent upsert of individual payments (by id). Unknown batches get their metadata fetched first (FK). Returns counts.
export async function upsertPayments(db, payments, { get = request, now = new Date().toISOString(), dryRun = false } = {}) {
  const knownB = db.prepare("SELECT 1 FROM batches WHERE id=?"), knownP = db.prepare("SELECT updatedAt, status FROM payments WHERE id=?");
  const missingBatches = [...new Set(payments.map(batchIdOf).filter(id => id && !knownB.get(id)))];
  let inserted = 0, updated = 0, unchanged = 0, skipped = 0;
  for (const p of payments) { if (!batchIdOf(p)) { skipped++; continue; } const o = knownP.get(p.id); if (!o) inserted++; else if (o.updatedAt === (p.updatedAt ?? null) && o.status === (p.status ?? null)) unchanged++; else updated++; }
  if (dryRun) return { inserted, updated, unchanged, skipped, newBatches: missingBatches.length };
  const metas = [];
  for (const id of missingBatches) { const r = await get("GET", `/batches/${encodeURIComponent(id)}`); metas.push(r.batch ?? r); }
  const ins = db.prepare(UPSERT), touched = new Set();
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const b of metas) upsertBatchMeta(db, b);
    for (const p of payments) { const b = batchIdOf(p); if (!b) continue; ins.run(toPaymentRow(p, b, now)); touched.add(b); }
    const rc = db.prepare("UPDATE batches SET returnedCount=(SELECT count(*) FROM payments WHERE batchId=? AND status='returned') WHERE id=?");
    for (const b of touched) rc.run(b, b);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return { inserted, updated, unchanged, skipped, newBatches: missingBatches.length };
}

// Walk all payments newest-updated first until we pass (watermark - 2 min). Fetch everything first, then upsert + advance in one
// transaction-protected step; any failure throws before the watermark moves.
export async function paymentDelta(db, { get = request, now = new Date(), dryRun = false, pageSize = PAGE, maxPages = MAX_PAGES } = {}) {
  const wm = getState(db, PAY_WM), runStart = now.toISOString();
  if (!wm) { // first run: start from the backfill start if there was one, else now; nothing fetched
    const start = getState(db, "backfill.startedAt") || runStart;
    if (!dryRun) setState(db, PAY_WM, start);
    return { firstRun: true, watermark: start, fetched: 0 };
  }
  const floor = new Date(Date.parse(wm) - OVERLAP_MS).toISOString();
  const rows = []; let page = 1, pages = 1, reachedFloor = false;
  for (; page <= maxPages; page++) {
    const r = await get("GET", "/payments", { query: { page, pageSize, orderBy: "updatedAt", sortBy: "desc" } });
    const ps = r.payments ?? []; pages = r.meta?.pages ?? page;
    for (const p of ps) { if (String(p.updatedAt ?? "") >= floor) rows.push(p); else reachedFloor = true; }
    if (reachedFloor || !ps.length || page >= pages) break;
  }
  if (!reachedFloor && page > maxPages) throw new Error(`payment delta exceeded ${maxPages} pages without reaching the watermark; not advancing`);
  const latest = newest(rows);
  let max = null; for (const p of latest.values()) if (p.updatedAt && (!max || p.updatedAt > max)) max = p.updatedAt;
  const next = max && max > wm ? max : wm; // never past what we saw; never backwards
  const counts = await upsertPayments(db, [...latest.values()], { get, dryRun });
  if (!dryRun) setState(db, PAY_WM, next);
  return { firstRun: false, dryRun, from: floor, pagesRead: Math.min(page, pages), fetched: rows.length, distinct: latest.size, ...counts, watermark: dryRun ? wm : next, ...(dryRun ? { wouldAdvanceTo: next } : {}) };
}

// Returned sweep: status=returned on every batch created in the last 90 days (late returns don't bump batch updatedAt).
export async function returnedSweep(db, { get = request, now = new Date(), dryRun = false, days = RETURNED_DAYS } = {}) {
  const since = new Date(now.getTime() - days * 864e5).toISOString();
  const ids = new Set(db.prepare("SELECT id FROM batches WHERE createdAt >= ?").all(since).map(r => r.id));
  // also batches the cache hasn't seen yet (listing filters on batch updatedAt, which covers recently created ones)
  for (let page = 1; ; page++) { const r = await get("GET", "/batches", { query: { page, pageSize: 100, startDate: since } }); for (const b of r.batches ?? []) if (b.createdAt >= since) ids.add(b.id); if (page >= (r.meta?.pages ?? 1)) break; }
  const rows = [];
  for (const id of ids) for (let page = 1; ; page++) {
    const r = await get("GET", `/batches/${encodeURIComponent(id)}/payments`, { query: { page, pageSize: PAGE, status: "returned" } });
    for (const p of r.payments ?? []) rows.push({ ...p, batch: p.batch ?? { id } });
    if (page >= (r.meta?.pages ?? 1)) break;
  }
  const counts = await upsertPayments(db, [...newest(rows).values()], { get, dryRun });
  if (!dryRun) setState(db, RETURNED_AT, now.toISOString());
  return { batches: ids.size, returnedSeen: rows.length, ...counts };
}
export const returnedDue = (db, now = new Date()) => { const t = Date.parse(getState(db, RETURNED_AT) ?? ""); return !(t > now.getTime() - RETURNED_EVERY_MS + 5 * 60e3); };

// ---------- payday-day detection ----------
// A payday day = today (local tz) is the payday date, or a payment batch in a configured group (any batch, if none) was created/sent/completed today.
export async function paydayToday(db, { get = request, now = new Date(), cfg = paydayConfig() } = {}) {
  const t = tzParts(now, cfg.tz);
  if (t.day === clampDay(t.year, t.month, cfg.payday)) return { payday: true, reason: "payday date" };
  const start = zonedMidnightUtc(t.year, t.month, t.day, cfg.tz).toISOString();
  const today = s => s && s >= start && s <= now.toISOString();
  const hit = b => inAnyGroup(b.description) && (today(b.createdAt) || today(b.sentAt) || today(b.completedAt));
  if (db.prepare("SELECT description, createdAt, sentAt, completedAt FROM batches WHERE coalesce(createdAt,'') >= ? OR coalesce(sentAt,'') >= ? OR coalesce(completedAt,'') >= ?").all(start, start, start).some(hit)) return { payday: true, reason: "payday batch in cache" };
  const r = await get("GET", "/batches", { query: { page: 1, pageSize: 50, startDate: start } });
  if ((r.batches ?? []).some(hit)) return { payday: true, reason: "payday batch (live)" };
  return { payday: false };
}

// ---------- jobs ----------
export async function runJob(job, { get = request, cfg = loadConfig(), dryRun = false, now = new Date(), db: dbIn, lock, log = () => {}, backfillPids = runningBackfill } = {}) {
  if (!["payments", "recipients"].includes(job)) throw new Error(`unknown job ${job}`);
  if (!cfg.syncEnabled) return { job, skipped: true, reason: "sync disabled" };
  if (job === "payments" && !cfg.paymentCache) return { job, skipped: true, reason: "payment cache off" };
  if (job === "recipients" && !cfg.recipientCache) return { job, skipped: true, reason: "recipient cache off" };
  lock ??= lockPath();
  const bf = backfillPids(); if (bf.length) return { job, skipped: true, reason: `backfill running (pid ${bf.join(",")})` };
  const release = dryRun ? () => {} : acquireLock(lock, { label: `${job}-sync` });
  if (!release) return { job, skipped: true, reason: `lock held by ${lockHolder(lock)?.label ?? "another job"}` };
  const db = dbIn ?? openDb(dryRun ? { readOnly: true } : {});
  try {
    if (job === "payments") {
      const delta = await paymentDelta(db, { get, now, dryRun });
      log(`delta ${JSON.stringify(delta)}`);
      let returned = null;
      if (returnedDue(db, now)) { returned = await returnedSweep(db, { get, now, dryRun }); log(`returned ${JSON.stringify(returned)}`); }
      return { job, delta, returned: returned ?? "not due" };
    }
    const pd = await paydayToday(db, { get, now });
    if (pd.payday) return { job, skipped: true, reason: `payday day (${pd.reason}); watermark not advanced` };
    return { job, sweep: await sweepRecipients(db, { get, now, dryRun }) };
  } finally { if (!dbIn) db.close(); release(); }
}
