#!/usr/bin/env node
// CLI for launchd: sh run.sh sync payments|recipients [--dry-run]. Output: counts only (no names, emails or keys).
const [maj, min] = process.versions.node.split(".").map(Number);
if (maj < 22 || (maj === 22 && min < 5)) { process.stderr.write(`Node >= 22.5 required; found ${process.version}\n`); process.exit(1); }
const job = process.argv[2], dryRun = process.argv.includes("--dry-run");
const { runJob, mkLogger } = await import("./jobs.mjs");
const { detectEnvironment } = await import("./env.mjs");
const log = mkLogger(job === "payments" ? "payment-sync" : "recipient-sync");
const env = detectEnvironment();
if (env.conflict) { log(`refusing: environment conflict`); process.exit(2); }
const t0 = Date.now();
log(`start ${job}${dryRun ? " (dry run)" : ""} env=${env.environment} key=${env.keyFingerprint}`);
try {
  const r = await runJob(job, { dryRun, log });
  const line = JSON.stringify({ ...r, seconds: Math.round((Date.now() - t0) / 1000) });
  log(`done ${line}`); process.stdout.write(line + "\n"); process.exit(0);
} catch (e) { log(`FAILED (watermark not advanced): ${String(e?.message || e).slice(0, 300)}`); process.stderr.write(`failed: ${String(e?.message || e).slice(0, 300)}\n`); process.exit(1); }
