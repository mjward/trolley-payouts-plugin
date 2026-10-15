// Which Trolley environment are these keys for? Never prints keys; uses sha256(accessKey)[:12] fingerprints.
// Trolley's API has no documented sandbox/live flag and both use https://api.trolley.com, so we rely on:
//  1. TROLLEY_KNOWN_KEYS="<fp>=sandbox,<fp>=production" (fingerprints registry, safe to commit/share), and/or
//  2. TROLLEY_ENVIRONMENT=sandbox|production (declared by whoever configures the plugin).
// If both are set and disagree, every Trolley call is refused (likely a leaked/mixed-up key).
import { createHash } from "node:crypto";
import { ToolError } from "./client.mjs";

export const fingerprint = key => createHash("sha256").update(String(key)).digest("hex").slice(0, 12);
const norm = v => { const s = String(v || "").trim().toLowerCase(); return s === "live" || s === "prod" ? "production" : s === "sandbox" || s === "production" ? s : null; };

export function detectEnvironment(env = process.env) {
  const key = env.TROLLEY_ACCESS_KEY;
  if (!key) return { environment: "unknown", source: "no TROLLEY_ACCESS_KEY", keyFingerprint: null };
  const fp = fingerprint(key);
  const registry = Object.fromEntries(String(env.TROLLEY_KNOWN_KEYS || "").split(",").map(s => s.trim().split("=")).filter(p => p.length === 2).map(([f, e]) => [f.trim(), norm(e)]));
  const fromFp = registry[fp] || null, declared = norm(env.TROLLEY_ENVIRONMENT);
  if (fromFp && declared && fromFp !== declared)
    return { environment: "conflict", source: `TROLLEY_ENVIRONMENT=${declared} but key fingerprint ${fp} is registered as ${fromFp}`, keyFingerprint: fp, conflict: true };
  if (fromFp) return { environment: fromFp, source: `key fingerprint ${fp} in TROLLEY_KNOWN_KEYS${declared ? " (matches TROLLEY_ENVIRONMENT)" : ""}`, keyFingerprint: fp };
  if (declared) return { environment: declared, source: "TROLLEY_ENVIRONMENT (fingerprint not registered)", keyFingerprint: fp };
  return { environment: "unknown", source: "set TROLLEY_ENVIRONMENT or register the fingerprint in TROLLEY_KNOWN_KEYS", keyFingerprint: fp };
}
export function assertNoConflict(env = process.env) {
  const d = detectEnvironment(env);
  if (d.conflict) throw new ToolError(`Refusing to call Trolley: ${d.source}. Check which keys are loaded.`);
  return d;
}
export const whoamiTool = {
  name: "whoami",
  description: "Read-only, no Trolley call. Reports which Trolley environment (sandbox | production | unknown | conflict) the loaded keys belong to, how that was determined, and the key fingerprint (sha256 prefix; never the key). Use before any analysis when the environment matters.",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  run: async () => detectEnvironment(),
};
