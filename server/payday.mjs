import { badge } from "./badge.mjs";
// payday_summary: the monthly payday cycle (payday = 15th, Melbourne). Read-only (GET + local SQLite).
import { ToolError, request as defaultRequest } from "./client.mjs";
import { openDb, upsertBatchMeta, replaceBatchPayments } from "./db.mjs";
import { planBatch, mkCtx, listAll, DEFAULT_CONCURRENCY } from "./sync.mjs";
import { toMicros, fromMicros } from "./agg.mjs";

export const DEFAULT_TZ = "Australia/Melbourne", DEFAULT_PAYDAY = 15, DEFAULT_CREATE_DAY = 11;
// Config from env: TROLLEY_TIMEZONE (IANA), TROLLEY_PAYDAY_DAY and TROLLEY_BATCH_CREATE_DAY (integers 1-28). An invalid value falls back to the default with a warning.
const warned = new Set();
export function validTz(tz) { try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; } }
export function paydayConfig(env = process.env) {
  const warnings = [];
  let tz = (env.TROLLEY_TIMEZONE || "").trim() || DEFAULT_TZ;
  if (!validTz(tz)) { warnings.push(`TROLLEY_TIMEZONE "${env.TROLLEY_TIMEZONE}" isn't a valid IANA time zone; using ${DEFAULT_TZ}.`); tz = DEFAULT_TZ; }
  const day = (name, def) => { const raw = (env[name] ?? "").trim(); if (raw === "") return def;
    const n = Number(raw); if (Number.isInteger(n) && n >= 1 && n <= 31) return n;
    warnings.push(`${name} "${raw}" must be an integer from 1 to 31; using ${def}.`); return def; };
  const payday = day("TROLLEY_PAYDAY_DAY", DEFAULT_PAYDAY), createDay = day("TROLLEY_BATCH_CREATE_DAY", DEFAULT_CREATE_DAY);
  for (const w of warnings) if (!warned.has(w)) { warned.add(w); process.stderr.write(`trolley: ${w}\n`); }
  return { tz, payday, createDay, warnings };
}
export const TZ = DEFAULT_TZ, PAYDAY = DEFAULT_PAYDAY;
export const RECENT_PAGE = 100;
export const NOT_YET = "not yet in waiting approval";
export const AWAITING = "awaiting_approval";
// Batch groups: TROLLEY_BATCH_GROUPS="Group A,Group B" (comma-separated, matched as whole words in the batch description,
// case-insensitive). No groups configured: every batch in the cycle window is listed on its own.
export const batchGroups = (env = process.env) => (env.TROLLEY_BATCH_GROUPS || "").split(",").map(s => s.trim()).filter(Boolean);
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
export const groupRe = g => new RegExp(`(^|[^\\p{L}\\p{N}])${esc(g)}($|[^\\p{L}\\p{N}])`, "iu");
export const prefixRe = g => new RegExp(`^\\s*\\d{4}-\\d{2}\\s+${esc(g)}($|[^\\p{L}\\p{N}])`, "iu");
export const groupOf = (desc, groups = batchGroups()) => groups.find(g => groupRe(g).test(desc || "")) ?? null;
// True if the description belongs to a configured group (any batch, when no groups are configured).
export const inAnyGroup = (desc, groups = batchGroups()) => groups.length === 0 || groupOf(desc, groups) != null;
export const isPrefixed = (desc, groups = batchGroups()) => groups.some(g => prefixRe(g).test(desc || ""));
const MONTHS = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];

export const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const clampDay = (y, m, d) => Math.min(d, daysIn(y, m));
export function tzParts(date, tz = paydayConfig().tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    .formatToParts(date).filter(x => x.type !== "literal").map(x => [x.type, Number(x.value)]));
  return p;
}
// UTC instant of local midnight (y, m 1-12, d) in tz.
export function zonedMidnightUtc(y, m, d, tz = paydayConfig().tz) {
  let t = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 3; i++) { const p = tzParts(new Date(t), tz); const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second); t += Date.UTC(y, m - 1, d) - asUtc; }
  return new Date(t);
}
export function fmtMelbourne(iso, tz = paydayConfig().tz) {
  if (!iso) return null;
  const d = new Date(iso);
  const s = new Intl.DateTimeFormat("en-AU", { timeZone: tz, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" }).format(d);
  return s;
}

export function resolveCycle(arg, now = new Date(), cfg = paydayConfig()) {
  const t = tzParts(now, cfg.tz);
  const before15 = t.day < clampDay(t.year, t.month, cfg.payday);
  if (arg == null || String(arg).trim() === "") {
    let y = t.year, m = t.month; if (before15) { m--; if (m === 0) { m = 12; y--; } }
    return { year: y, month: m };
  }
  const s = String(arg).trim().toLowerCase();
  const mm = /^([a-z]+)\.?(?:\s+(\d{4}))?$/.exec(s) || /^(\d{4})-(\d{1,2})$/.exec(s);
  if (!mm) throw new ToolError(`Couldn't read month "${arg}". Use e.g. Oct, October, or Oct 2026.`);
  let month, year;
  if (/^\d{4}$/.test(mm[1])) { year = Number(mm[1]); month = Number(mm[2]); }
  else { const idx = MONTHS.findIndex(x => mm[1].startsWith(x) && "january february march april may june july august september october november december".split(" ")[MONTHS.indexOf(x)].startsWith(mm[1]));
    if (idx < 0) throw new ToolError(`Unknown month "${arg}".`); month = idx + 1; year = mm[2] ? Number(mm[2]) : undefined; }
  if (!(month >= 1 && month <= 12)) throw new ToolError(`Unknown month "${arg}".`);
  if (year === undefined) { // most recent payday of that month on or before today (Melbourne)
    year = t.year;
    if (month > t.month || (month === t.month && before15)) year--;
  }
  return { year, month };
}

export function cycleWindow({ year, month }, cfg = paydayConfig()) {
  // From (createDay - 3) to the end of payday. If createDay is after payday, the batches are created in the previous month.
  let sy = year, sm = month;
  if (cfg.createDay > cfg.payday) { sm--; if (sm === 0) { sm = 12; sy--; } }
  const startDay = Math.max(1, clampDay(sy, sm, cfg.createDay) - 3), pd = clampDay(year, month, cfg.payday);
  const start = zonedMidnightUtc(sy, sm, startDay, cfg.tz);
  const end = zonedMidnightUtc(year, month, pd + 1, cfg.tz); // exclusive: through the end of payday
  return { start, end, startDay, tz: cfg.tz, payday: `${year}-${String(month).padStart(2, "0")}-${String(pd).padStart(2, "0")}` };
}

// Classify the window's batches into the configured groups (first matching group wins). A "YYYY-MM <group>" prefix ranks a
// candidate first (the prefix isn't necessarily the payday month), then the earliest created. With no groups configured, each
// batch in the window is its own entry, keyed by its description. Configured groups always appear (empty = missing).
const createdCmp = (x, y) => (x.createdAt < y.createdAt ? -1 : x.createdAt > y.createdAt ? 1 : 0);
export function classify(batches, win, groups = batchGroups()) {
  const inWin = batches.filter(b => { const t = Date.parse(b.createdAt); return t >= win.start.getTime() && t < win.end.getTime(); });
  if (!groups.length) {
    const out = {};
    for (const b of [...inWin].sort(createdCmp)) { let k = labelOf(b) || b.id; if (out[k]) k = `${k} (${b.id})`; out[k] = [b]; }
    return out;
  }
  const out = Object.fromEntries(groups.map(g => [g, []]));
  for (const b of inWin) { const g = groupOf(b.description, groups); if (g) out[g].push(b); }
  const rank = b => (isPrefixed(b.description, groups) ? 0 : 1);
  // Use plain word matches (e.g. 'ACME GROUP A PAYOUT …') only if there's no YYYY-MM-prefixed candidate.
  for (const k of Object.keys(out)) if (out[k].some(b => rank(b) === 0)) out[k] = out[k].filter(b => rank(b) === 0);
  for (const k of Object.keys(out)) out[k].sort((x, y) => rank(x) - rank(y) || (x.createdAt < y.createdAt ? -1 : x.createdAt > y.createdAt ? 1 : 0));
  return out;
}
export const labelOf = b => (b.description || "").replace(/\s*\([0-9a-f-]{36}\)\s*$/i, "");
export const missingGroup = (kinds, groups = batchGroups()) => (groups.length ? Object.values(kinds).some(a => a.length === 0) : Object.keys(kinds).length === 0);
export const statusFlag = s => (s === "open" ? NOT_YET : null);

export async function paydaySummary(a = {}, { get = defaultRequest, db: dbIn, now = new Date() } = {}) {
  const t0 = Date.now();
  const cfg = paydayConfig();
  const cycle = resolveCycle(a.month, now, cfg);
  const win = cycleWindow(cycle, cfg);
  const ctx = mkCtx(Math.max(DEFAULT_CONCURRENCY, 10));
  const db = dbIn ?? openDb();
  try {
    // One listing call scoped by startDate (Trolley filters on updatedAt >= start, which includes batches created in the window).
    const notes = [];
    let listed = await listAll("/batches", "batches", { query: { startDate: new Date(Math.min(win.start.getTime(), zonedMidnightUtc(cycle.year, cycle.month, 1, cfg.tz).getTime())).toISOString() }, ctx, get });
    let kinds = classify(listed, win);
    if (missingGroup(kinds)) {
      // Fallback: don't trust the filter (or a cold/stale cache). Fetch the most recent batches with any status, newest first, and merge them in.
      const recent = (await get("GET", "/batches", { query: { page: 1, pageSize: RECENT_PAGE }, ...ctx.opts })).batches || [];
      const byId = new Map([...listed, ...recent].map(b => [b.id, b]));
      listed = [...byId.values()].sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1));
      kinds = classify(listed, win);
      notes.push(`Filtered listing was missing a batch; also fetched the ${recent.length} most recent batches (any status).`);
    }
    // Cache any batches we'd never seen (metadata only). Existing rows are left alone so the refresh plan below still sees their old updatedAt.
    const known = db.prepare("SELECT 1 FROM batches WHERE id=?");
    for (const b of listed) if (!known.get(b.id) && !Object.values(kinds).some(a => a.includes(b))) upsertBatchMeta(db, b);
    const tp = tzParts(now, cfg.tz); const result = { payday: win.payday, timezone: cfg.tz, statusLine: `Payday ${win.payday} (${cfg.tz})`, ...(cfg.warnings.length ? { configWarnings: cfg.warnings } : {}), today: `${tp.year}-${String(tp.month).padStart(2,"0")}-${String(tp.day).padStart(2,"0")}`, window: { start: fmtMelbourne(win.start, cfg.tz), end: fmtMelbourne(new Date(win.end - 1), cfg.tz) }, batches: {} };
    const getStored = db.prepare("SELECT updatedAt, status, returnedCount, lastSyncedAt FROM batches WHERE id=?");
    const groups = batchGroups(); if (groups.length) result.groups = groups;
    for (const kind of Object.keys(kinds)) {
      const found = kinds[kind];
      if (found.length === 0) { notes.push(`${kind} batch not found for the ${win.payday} cycle (searched batches created ${fmtMelbourne(win.start, cfg.tz)} to ${fmtMelbourne(new Date(win.end - 1), cfg.tz)}).`); result.batches[kind] = null; continue; }
      if (found.length > 1) notes.push(`Ambiguous: ${found.length} ${kind} batches in the window (${found.map(b => b.id).join(", ")}); using ${found[0].id} (a YYYY-MM-prefixed description, then the earliest created).`);
      const b = found[0];
      const plan = planBatch(b, getStored.get(b.id), {});
      let refreshed = "cached";
      if (plan === "refetch" || plan === "meta") {
        replaceBatchPayments(db, b, plan === "meta" ? [] : await listAll(`/batches/${encodeURIComponent(b.id)}/payments`, "payments", { ctx, get })); refreshed = "refetched";
      } else if (plan === "check") {
        const r = await get("GET", `/batches/${encodeURIComponent(b.id)}/payments`, { query: { status: "returned", page: 1, pageSize: 1 }, ...ctx.opts });
        if ((r.meta?.records ?? 0) !== getStored.get(b.id)?.returnedCount) { replaceBatchPayments(db, b, await listAll(`/batches/${encodeURIComponent(b.id)}/payments`, "payments", { ctx, get })); refreshed = "refetched (new returns)"; }
        else { upsertBatchMeta(db, b); refreshed = "checked"; }
      } else upsertBatchMeta(db, b);
      result.batches[kind] = { ...summarize(db, b), refreshed };
    }
    // Other batches created this calendar month (in TROLLEY_TIMEZONE) that aren't the cycle's payout runs: ad-hoc payouts and
    // mid-month re-runs that reuse a group's label. Listed, never counted.
    const used = new Set(Object.values(result.batches).filter(Boolean).map(b => b.id));
    const mStart = zonedMidnightUtc(cycle.year, cycle.month, 1, cfg.tz).getTime();
    const mEnd = zonedMidnightUtc(cycle.month === 12 ? cycle.year + 1 : cycle.year, cycle.month === 12 ? 1 : cycle.month + 1, 1, cfg.tz).getTime();
    result.otherBatchesThisMonth = listed.filter(b => !used.has(b.id) && Date.parse(b.createdAt) >= mStart && Date.parse(b.createdAt) < mEnd)
      .sort((x, y) => (x.createdAt < y.createdAt ? -1 : 1))
      .map(b => ({ id: b.id, label: labelOf(b), status: b.status, statusBadge: badge(b.status), createdAtLocal: fmtMelbourne(b.createdAt, cfg.tz), totalPayments: b.totalPayments ?? null,
        kind: isPrefixed(b.description) ? "group-labelled (not counted)" : "ad-hoc (not counted)" }));
    if (result.otherBatchesThisMonth.length) notes.push(`Other batches this month: ${result.otherBatchesThisMonth.length} (not counted in the cycle).`);
    const parts = Object.values(result.batches).filter(Boolean);
    result.combined = combine(parts);
    result.notes = notes; result.callsMade = ctx.calls; result.elapsedMs = Date.now() - t0;
    return result;
  } finally { if (!dbIn) db.close(); }
}

function summarize(db, b) {
  const rows = db.prepare("SELECT status, sourceAmount, sourceCurrency, fees, targetAmount, targetCurrency FROM payments WHERE batchId=?").all(b.id);
  const totals = {}, n = { processed: 0, failed: 0, returned: 0 };
  let fees = 0n, target = 0n, targetSame = true; const others = {};
  for (const r of rows) { totals[r.sourceCurrency] = (totals[r.sourceCurrency] || 0n) + toMicros(r.sourceAmount); if (r.status in n) n[r.status]++; else others[r.status ?? "unknown"] = (others[r.status ?? "unknown"] || 0) + 1;
    if (r.fees != null) fees += toMicros(String(r.fees)); if (r.targetCurrency === r.sourceCurrency && r.targetAmount != null) target += toMicros(String(r.targetAmount)); else targetSame = false; }
  const flag = statusFlag(b.status);
  return { id: b.id, label: (b.description || "").replace(/\s*\([0-9a-f-]{36}\)\s*$/i, ""), status: b.status, statusBadge: badge(b.status), ...(flag ? { flag } : {}),
    createdAtLocal: fmtMelbourne(b.createdAt), createdAtMelbourne: fmtMelbourne(b.createdAt), totalPayments: rows.length,
    totalAmount: Object.fromEntries(Object.entries(totals).map(([c, v]) => [c, fromMicros(v)])), amountBasis: "sum of payment sourceAmount", paymentFees: fromMicros(fees), ...(targetSame ? { paymentTargetSum: fromMicros(target) } : {}),
    batchAmount: b.amount != null ? { [b.currency || "?"]: String(b.amount) } : null, ...amountDiff(totals, b), successful: n.processed, failed: n.failed, returned: n.returned, otherStatuses: others };
}
// Trolley's batch.amount is its own batch total. It can differ from the sum of the payments' sourceAmount (they can differ
// by a few percent), so we report both plus the difference, plus the summed fees and targetAmount (where the currency matches) to help reconcile.
function amountDiff(totals, b) {
  if (b.amount == null || !b.currency || !(b.currency in totals)) return {};
  return { batchAmountMinusPaymentSum: fromMicros(toMicros(String(b.amount)) - totals[b.currency]) };
}
function combine(parts) {
  const totals = {}; let successful = 0, failed = 0, returned = 0, totalPayments = 0;
  const otherStatuses = {};
  for (const p of parts) { totalPayments += p.totalPayments; successful += p.successful; failed += p.failed; returned += p.returned;
    for (const [k, v] of Object.entries(p.otherStatuses || {})) otherStatuses[k] = (otherStatuses[k] || 0) + v;
    for (const [c, v] of Object.entries(p.totalAmount)) totals[c] = (totals[c] || 0n) + toMicros(v); }
  return { totalPayments, totalAmount: Object.fromEntries(Object.entries(totals).map(([c, v]) => [c, fromMicros(v)])), successful, failed, returned, otherStatuses };
}

export const paydaySummaryTool = {
  name: "payday_summary",
  description: `Read-only. Summarise a payday cycle (payday = the 15th, Australia/Melbourne). Finds the cycle's payment batches created from (TROLLEY_BATCH_CREATE_DAY − 3, default 8th) to payday (TROLLEY_PAYDAY_DAY, default 15th) in TROLLEY_TIMEZONE (default Australia/Melbourne). If TROLLEY_BATCH_GROUPS is set (e.g. "Group A,Group B"), it picks one batch per group by whole-word, case-insensitive match on the description (e.g. "YYYY-MM Group A (…)"); otherwise every batch in the window is listed. Returns per-batch and combined total amount per currency, successful (processed) / failed / returned counts, batch id, status and createdAt (Melbourne). Batches still 'open' carry the flag "${NOT_YET}". month: optional "Oct", "October", "Oct 2026" or "2026-10"; default is the most recent 15th on or before today (Melbourne). Refreshes only the cycle's batches when the local copy may be behind.`,
  inputSchema: { type: "object", properties: { month: { type: "string" } } },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  run: async a => {
    const { loadConfig } = await import("./config.mjs");
    if (loadConfig().paymentCache) return paydaySummary(a);
    const db = openDb({ memory: true }); // payment cache off: live fetch into a throwaway in-memory DB
    try { return { ...(await paydaySummary(a, { db })), source: "live (payment cache disabled)" }; } finally { db.close(); }
  },
};
