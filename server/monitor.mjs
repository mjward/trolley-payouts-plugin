// Payday batch monitor (LaunchAgent, every 15 min). Runs only on payday: TROLLEY_PAYDAY_DAY (clamped), moved to Monday if it falls
// on a weekend (TROLLEY_TIMEZONE, no public holidays). GET only, live listing, no names, no keys. Notifies on status transitions,
// once per batch per stuck condition, and on failure-rate thresholds. The word "pending" is never used in messages.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { request } from "./client.mjs";
import { dbPath } from "./db.mjs";
import { paydayConfig, tzParts, clampDay, zonedMidnightUtc, cycleWindow, classify, fmtMelbourne, batchGroups } from "./payday.mjs";
import { readConfigFile, parseBool } from "./config.mjs";

export const STATUS_TEXT = { open: "created (open)", initiating: "initiating", awaiting_approval: "waiting for approval", accepted: "approved (FX accepted)", processing: "approved (processing)", complete: "complete", failed: "failed" };
export const NOTIFY_ON = new Set(["awaiting_approval", "processing", "complete", "failed"]);
export const statusText = s => STATUS_TEXT[s] ?? String(s ?? "unknown").replace(/pending/gi, "waiting");
export const monitorEnabled = (env = process.env, file = readConfigFile(env)) => parseBool(env.TROLLEY_PAYDAY_MONITOR) ?? parseBool(file.paydayMonitor) ?? true;
const num = (v, d) => { const n = Number(v); return v != null && v !== "" && Number.isFinite(n) && n >= 0 ? n : d; };
export const failConfig = (env = process.env) => ({ warn: num(env.TROLLEY_FAIL_RATE_WARN, 3), high: num(env.TROLLEY_FAIL_RATE_HIGH, 10), minCount: num(env.TROLLEY_FAIL_MIN_COUNT, 25), smallCount: num(env.TROLLEY_FAIL_SMALL_BATCH_COUNT, 10), smallBatch: num(env.TROLLEY_FAIL_SMALL_BATCH_SIZE, 300) });

// Effective payday for (year, month): payday day clamped to the month; Sat -> Mon (+2), Sun -> Mon (+1).
export function effectivePayday(year, month, cfg = paydayConfig()) {
  const d = clampDay(year, month, cfg.payday), dow = new Date(Date.UTC(year, month - 1, d)).getUTCDay();
  const s = new Date(Date.UTC(year, month - 1, d + (dow === 6 ? 2 : dow === 0 ? 1 : 0)));
  return { year: s.getUTCFullYear(), month: s.getUTCMonth() + 1, day: s.getUTCDate(), nominalDay: d, shifted: dow === 6 || dow === 0 };
}
const ymd = p => `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
// Active window: 48 h from 00:00 local on the effective payday (payday = day 1, the next day = day 2), or null.
// Checks this month's and last month's cycle (a weekend shift or day 2 can cross the month end).
export function paydayToday(now = new Date(), cfg = paydayConfig()) {
  const t = tzParts(now, cfg.tz);
  for (const [y, m] of [[t.year, t.month], t.month === 1 ? [t.year - 1, 12] : [t.year, t.month - 1]]) {
    const p = effectivePayday(y, m, cfg);
    const s = zonedMidnightUtc(p.year, p.month, p.day, cfg.tz).getTime(), d2 = zonedMidnightUtc(p.year, p.month, p.day + 1, cfg.tz).getTime(), e = zonedMidnightUtc(p.year, p.month, p.day + 2, cfg.tz).getTime();
    const n = now.getTime();
    if (n >= s && n < e) return { cycle: { year: y, month: m }, ...p, dayNum: n >= d2 ? 2 : 1, windowEnd: new Date(e), hour: t.hour, minute: t.minute, tz: cfg.tz };
  }
  return null;
}

const label = b => (b.description || b.id).replace(/\s*\([0-9a-f-]{36}\)\s*$/i, "");
const amt = b => (b.amount != null ? `${b.currency || ""} ${Number(b.amount).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.trim() : "amount n/a");
const facts = b => `${b.totalPayments ?? "?"} payments, ${amt(b)}`;

// This cycle's batch for each configured group (or every batch in the window when no groups are set), plus any other batch created since the window started.
export function track(batches, pd, now = new Date(), cfg = paydayConfig(), groups = batchGroups()) {
  const win = cycleWindow(pd.cycle, cfg);
  const end = new Date(Math.max(win.end.getTime(), zonedMidnightUtc(pd.year, pd.month, pd.day + 2, cfg.tz).getTime()));
  const kinds = classify(batches, { start: win.start, end }, groups), tracked = new Map();
  for (const k of Object.keys(kinds)) if (kinds[k][0]) tracked.set(kinds[k][0].id, { b: kinds[k][0], kind: groups.length ? k : "Other" });
  for (const b of batches) { const c = Date.parse(b.createdAt); if (!tracked.has(b.id) && c >= win.start.getTime() && c <= now.getTime()) tracked.set(b.id, { b, kind: "Other" }); }
  return { tracked, kinds };
}
export const needsFailCount = b => b.status === "processing" || b.status === "complete";

// Pure step: live batches + previous state + failure counts -> { messages, state }.
export function evaluate({ groups = batchGroups(), batches, state = { batches: {}, alerts: {} }, now = new Date(), cfg = paydayConfig(), pd = paydayToday(now, cfg), counts = {}, fc = failConfig() }) {
  const st = { batches: { ...state.batches }, alerts: { ...state.alerts } }, msgs = [], tz = cfg.tz;
  const { tracked, kinds } = track(batches, pd, now, cfg, groups);
  const when = b => fmtMelbourne(b.updatedAt || now.toISOString(), tz);
  const once = (key, title, body) => { if (st.alerts[key]) return; st.alerts[key] = now.toISOString(); msgs.push({ title, body, key }); };
  const rows = [], dn = pd.dayNum ?? 1, dk = `d${dn}`, onDay = dn === 2 ? "on day 2 of payday" : "on payday", dt = dn === 2 ? " (day 2)" : "";
  for (const { b, kind } of tracked.values()) {
    const prev = st.batches[b.id], tag = kind === "Other" ? "" : `${kind}: `;
    if (!prev) msgs.push({ title: `New batch: ${statusText(b.status)}`, body: `${tag}${label(b)}. ${facts(b)}. ${when(b)}`, key: `new:${b.id}` });
    else if (prev.status !== b.status && NOTIFY_ON.has(b.status)) msgs.push({ title: `Batch ${statusText(b.status)}`, body: `${tag}${label(b)} moved from ${statusText(prev.status)} to ${statusText(b.status)}. ${facts(b)}. ${when(b)}`, key: `tr:${b.id}:${b.status}` });
    st.batches[b.id] = { status: b.status, since: !prev || prev.status !== b.status ? (b.updatedAt || now.toISOString()) : prev.since, kind };
    if (b.status === "awaiting_approval" && pd.hour >= 12) once(`stuck-approval:${b.id}:${dk}`, `Batch still waiting for approval${dt}`, `${tag}${label(b)} is still waiting for approval at 12:00 ${onDay}. ${facts(b)}.`);
    if (b.status === "processing" && pd.hour >= 17) once(`stuck-processing:${b.id}:${dk}`, `Batch still processing${dt}`, `${tag}${label(b)} is still processing at 17:00 ${onDay}. ${facts(b)}.`);
    const c = counts[b.id], row = { kind, label: label(b), status: statusText(b.status), payments: b.totalPayments ?? null, amount: amt(b), created: fmtMelbourne(b.createdAt, tz) };
    if (c) {
      const total = Number(b.totalPayments) || 0, n = c.failed + c.returned, rate = total ? (n / total) * 100 : 0;
      Object.assign(row, { failed: c.failed, returned: c.returned, failRatePct: Number(rate.toFixed(2)) });
      const text = `${tag}${label(b)}: ${c.failed} failed + ${c.returned} returned of ${total} payments (${rate.toFixed(1)}%).`;
      const small = total < fc.smallBatch;
      if (small ? n >= fc.smallCount : rate > fc.warn && n >= fc.minCount) once(`fail-warn:${b.id}`, "Payment failures above threshold", text);
      if (rate > fc.high && (small ? n >= fc.smallCount : n >= fc.minCount)) once(`fail-high:${b.id}`, `High payment failure rate (over ${fc.high}%)`, text);
    }
    rows.push(row);
  }
  if (pd.hour >= 9) for (const k of groups) if (!kinds[k]?.length) once(`missing:${k}:${ymd(pd)}:${dk}`, `${k} batch missing${dt}`, `No ${k} batch found for payday ${ymd(pd)} as of 09:00 ${onDay}.`);
  for (const m of msgs) { m.title = m.title.replace(/pending/gi, "waiting for approval"); m.body = m.body.replace(/pending/gi, "waiting for approval"); }
  return { messages: msgs, state: st, tracked: rows };
}

export const statePath = (db = dbPath()) => join(dirname(db), "payday-monitor-state.json");
export const loadState = p => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return { batches: {}, alerts: {} }; } };
export function saveState(p, s) { mkdirSync(dirname(p), { recursive: true, mode: 0o700 }); writeFileSync(p + ".tmp", JSON.stringify(s), { mode: 0o600 }); renameSync(p + ".tmp", p); }

// argv, not string interpolation, so batch text can't inject AppleScript.
export function macNotify(title, body, run = (c, a) => execFileSync(c, a, { stdio: "ignore", timeout: 10000 })) {
  run("/usr/bin/osascript", ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", title, body]);
}
// Hook: TROLLEY_NOTIFY_EMAIL is reserved; email delivery isn't implemented (deliberately a no-op).
export function emailHook(_msg, env = process.env) { return env.TROLLEY_NOTIFY_EMAIL ? "email hook set (not implemented; nothing sent)" : null; }

export async function failCounts(get, b) {
  const q = s => get("GET", `/batches/${encodeURIComponent(b.id)}/payments`, { query: { status: s, page: 1, pageSize: 1 } }).then(r => Number(r.meta?.records ?? 0));
  const [failed, returned] = await Promise.all([q("failed"), q("returned")]);
  return { failed, returned };
}

export async function runMonitor({ get = request, now = new Date(), dryRun = false, state: stPath, notify = macNotify, log = () => {}, cfg = paydayConfig(), enabled = monitorEnabled(), fc = failConfig() } = {}) {
  if (!enabled) return { skipped: true, reason: "TROLLEY_PAYDAY_MONITOR is off" };
  const pd = paydayToday(now, cfg);
  if (!pd) { const t = tzParts(now, cfg.tz); return { skipped: true, reason: `outside payday window (this month's payday is ${ymd(effectivePayday(t.year, t.month, cfg))}, window is that day and the next)` }; }
  stPath ??= statePath();
  const batches = (await get("GET", "/batches", { query: { page: 1, pageSize: 100 } })).batches ?? []; // most recent, any status, live
  const counts = {};
  for (const { b } of track(batches, pd, now, cfg).tracked.values()) if (needsFailCount(b)) counts[b.id] = await failCounts(get, b);
  const out = evaluate({ batches, state: loadState(stPath), now, cfg, pd, counts, fc });
  for (const m of out.messages) { log(`${dryRun ? "WOULD NOTIFY" : "NOTIFY"} ${m.title} | ${m.body}`); if (!dryRun) { try { notify(m.title, m.body); } catch (e) { log(`notify failed: ${e.message}`); } emailHook(m); } }
  if (!dryRun) saveState(stPath, out.state);
  return { payday: ymd(pd), day: pd.dayNum, shifted: pd.shifted, dryRun, tracked: out.tracked, messages: out.messages.map(({ title, body }) => ({ title, body })) };
}
