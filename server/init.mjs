#!/usr/bin/env node
// CLI for /init: `sh run.sh init --device laptop|phone [--backfill]`. Writes the config (0600). Backfill runs only on a laptop with --backfill.
const args = process.argv.slice(2), get = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const { writeConfig, loadConfig, readConfigFile } = await import("./config.mjs");
let device = get("--device") || readConfigFile().device;
if (!device) { process.stderr.write("Is this device a laptop or a phone? Re-run with --device laptop or --device phone.\n"); process.exit(4); }
const written = writeConfig(device);
process.stderr.write(`Config written to ${written.path} (0600): device=${device}, recipientCache=${written.recipientCache}, paymentCache=${written.paymentCache}, syncEnabled=${written.syncEnabled}\n`);
const cfg = loadConfig();
if (device === "phone") { process.stderr.write("Phone: no backfill. Lookups go live to Trolley.\n"); process.stdout.write(JSON.stringify({ device, backfill: "skipped (phone)", config: cfg }) + "\n"); process.exit(0); }
if (!args.includes("--backfill")) { process.stdout.write(JSON.stringify({ device, backfill: "not requested (add --backfill)", config: cfg }) + "\n"); process.exit(0); }
process.argv = [process.argv[0], process.argv[1], ...(get("--concurrency") ? ["--concurrency", get("--concurrency")] : [])];
await import("./backfill.mjs");
