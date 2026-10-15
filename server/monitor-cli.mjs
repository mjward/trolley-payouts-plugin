#!/usr/bin/env node
// sh run.sh monitor run [--dry-run] [--date YYYY-MM-DD] [--now ISO] | sh run.sh monitor test-notify
const [maj, min] = process.versions.node.split(".").map(Number);
if (maj < 22 || (maj === 22 && min < 5)) { process.stderr.write(`Node >= 22.5 required; found ${process.version}\n`); process.exit(1); }
const { runMonitor, macNotify } = await import("./monitor.mjs");
const { acquireLock, mkLogger, lockHolder } = await import("./jobs.mjs");
const { detectEnvironment } = await import("./env.mjs");
const { dbPath } = await import("./db.mjs");
const { join, dirname } = await import("node:path");
const a = process.argv.slice(2), cmd = a[0], dryRun = a.includes("--dry-run"), ni = a.indexOf("--now");
if (cmd === "test-notify") { macNotify("Trolley payday monitor — test", "Test only. Real alerts look like: Group A: 2026-01 Group A payout moved from waiting for approval to approved (processing). 1200 payments, USD 150,000.00."); console.log("sent"); process.exit(0); }
if (cmd !== "run") { process.stderr.write("usage: sh run.sh monitor run [--dry-run] [--date YYYY-MM-DD] [--now ISO] | test-notify\n"); process.exit(64); }
const di = a.indexOf("--date");
let now = ni > 0 ? new Date(a[ni + 1]) : new Date();
if (di > 0) { // --date YYYY-MM-DD: that Melbourne date at the current Melbourne time of day
  const { tzParts, zonedMidnightUtc, paydayConfig } = await import("./payday.mjs"); const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(a[di + 1] || "");
  if (!m) { process.stderr.write("bad --date (YYYY-MM-DD)\n"); process.exit(64); }
  const tz = paydayConfig().tz, t = tzParts(new Date(), tz); now = new Date(zonedMidnightUtc(+m[1], +m[2], +m[3], tz).getTime() + (t.hour * 3600 + t.minute * 60) * 1000);
}
if (isNaN(now)) { process.stderr.write("bad --now\n"); process.exit(64); }
const log = mkLogger("payday-monitor");
const env = detectEnvironment(); if (env.conflict) { log("refusing: environment conflict"); process.exit(2); }
const lock = join(dirname(dbPath()), "payday-monitor.lock");
const release = dryRun ? () => {} : acquireLock(lock, { label: "payday-monitor" });
if (!release) { log(`skip: lock held (${lockHolder(lock)?.label})`); process.exit(0); }
try {
  const r = await runMonitor({ now, dryRun, log });
  if (!r.skipped || dryRun) log(`${r.skipped ? "skip" : "done"}${dryRun ? " (dry run)" : ""} ${JSON.stringify(r.skipped ? r : { payday: r.payday, tracked: r.tracked.length, messages: r.messages.length })}`);
  process.stdout.write(JSON.stringify(r, null, 1) + "\n");
} catch (e) { log(`FAILED: ${String(e?.message || e).slice(0, 300)}`); process.stderr.write("failed\n"); process.exitCode = 1; } finally { release(); }
