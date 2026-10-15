#!/usr/bin/env node
// CLI: full backfill for /init. Usage: sh run.sh backfill [--concurrency N]. Progress goes to stderr; the final JSON summary to stdout.
const [maj, min] = process.versions.node.split(".").map(Number);
if (maj < 22 || (maj === 22 && min < 5)) { process.stderr.write(`Node >= 22.5 required; found ${process.version}\n`); process.exit(1); }
const { backfill } = await import("./recipients.mjs");
const { detectEnvironment } = await import("./env.mjs");
const i = process.argv.indexOf("--concurrency"); const concurrency = i > 0 ? Number(process.argv[i + 1]) : undefined;
const { readConfigFile } = await import("./config.mjs");
if (readConfigFile().device === "phone" && !process.argv.includes("--force")) { process.stderr.write("Config says this device is a phone: backfill skipped (use --force to override).\n"); process.stdout.write(JSON.stringify({ skipped: true, status: "phone" }) + "\n"); process.exit(0); }
const env = detectEnvironment();
if (env.conflict) { process.stderr.write(`Refusing: ${env.source}\n`); process.exit(2); }
const { acquireLock, lockPath, lockHolder } = await import("./jobs.mjs");
const release = acquireLock(lockPath(), { label: "backfill" });
if (!release) { process.stderr.write(`Another sync holds the lock (${lockHolder(lockPath())?.label ?? "unknown"}); try again shortly.\n`); process.exit(5); }
process.on("exit", release);
process.stderr.write(`Backfill against ${env.environment} (key ${env.keyFingerprint}). Read-only. Safe to stop and re-run.\n`);
// Self-healing: re-run the (resumable) backfill up to MAX_PASSES times while it is incomplete and still making progress.
const MAX_PASSES = Number(process.env.TROLLEY_BACKFILL_PASSES ?? 3);
let r, prev = null;
for (let pass = 1; ; pass++) {
  r = await backfill(concurrency ? { concurrency } : {});
  if (r.complete || r.skipped) break;
  const rec = typeof r.recipients === "object" ? r.recipients : {};
  const key = `${r.batches?.failedBatches ?? 0}|${rec.failed ?? 0}`;
  const progressed = prev === null || key !== prev || (rec.filled ?? 0) > 0 || (rec.notFound ?? 0) > 0;
  const retryable = (r.batches?.failedBatches ?? 0) > 0 || (rec.failures || []).some(f => f.transient);
  if (pass >= MAX_PASSES || !progressed || !retryable) { process.stderr.write(`Stopping after pass ${pass}: ${pass >= MAX_PASSES ? "max passes reached" : !progressed ? "no progress since last pass" : "only permanent failures remain"}.\n`); break; }
  prev = key;
  process.stderr.write(`Pass ${pass} incomplete; retrying automatically (pass ${pass + 1}/${MAX_PASSES})…\n`);
  await new Promise(res => setTimeout(res, 5000));
}
process.stdout.write(JSON.stringify({ environment: env.environment, complete: r.complete, ...(r.skipped ? { status: r.status } : {}), batches: r.batches && { dbBatches: r.batches.dbBatches, dbPayments: r.batches.dbPayments, calls: r.batches.callsMade }, recipients: r.recipients && typeof r.recipients === "object" ? (({ failures, ...x }) => ({ ...x, failedIds: (failures || []).map(f => f.id) }))(r.recipients) : r.recipients, watermark: r.watermark ?? null }) + "\n");
process.exit(r.complete || r.skipped ? 0 : 3);
