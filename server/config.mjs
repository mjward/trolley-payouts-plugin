// Feature switches. Precedence: env var, then the config file written by /init, then the default (on).
//   TROLLEY_RECIPIENT_CACHE  recipients table read/write + lazy fill
//   TROLLEY_PAYMENT_CACHE    batches/payments store (payout_stats, payout_query, payday_summary)
//   TROLLEY_SYNC_ENABLED     sync_cache, backfill and any scheduled sync
// Config file: TROLLEY_CONFIG_FILE or ~/.config/trolley-plugin/config.json (mode 0600). It holds only these switches plus "device".
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const KEYS = { recipientCache: "TROLLEY_RECIPIENT_CACHE", paymentCache: "TROLLEY_PAYMENT_CACHE", syncEnabled: "TROLLEY_SYNC_ENABLED" };
export const PRESETS = { laptop: { recipientCache: true, paymentCache: true, syncEnabled: true }, phone: { recipientCache: false, paymentCache: false, syncEnabled: false } };
export const configPath = (env = process.env) => env.TROLLEY_CONFIG_FILE || join(env.HOME || homedir(), ".config", "trolley-plugin", "config.json");

export function parseBool(v) {
  if (typeof v === "boolean") return v;
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "true") return true;
  if (s === "false") return false;
  if (s !== "") process.stderr.write(`trolley: config value "${v}" isn't true or false; ignoring it.\n`);
  return undefined;
}
export function readConfigFile(env = process.env) {
  const p = configPath(env);
  if (!existsSync(p)) return {};
  try { const j = JSON.parse(readFileSync(p, "utf8")); return j && typeof j === "object" ? j : {}; } catch { return {}; }
}
export function loadConfig(env = process.env, file = readConfigFile(env)) {
  const out = { device: typeof file.device === "string" ? file.device : null, source: {} };
  for (const [k, envName] of Object.entries(KEYS)) {
    const e = parseBool(env[envName]), f = parseBool(file[k]);
    out[k] = e ?? f ?? true; out.source[k] = e !== undefined ? "env" : f !== undefined ? "file" : "default";
  }
  return out;
}
export function writeConfig(device, env = process.env) {
  if (!PRESETS[device]) throw new Error(`device must be laptop or phone, got "${device}"`);
  const p = configPath(env);
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify({ device, ...PRESETS[device], writtenAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(p, 0o600);
  return { path: p, device, ...PRESETS[device] };
}
export const SYNC_DISABLED = { skipped: true, status: "sync disabled", note: "TROLLEY_SYNC_ENABLED is off (env or /init config), so nothing was fetched or written." };
