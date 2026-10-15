import { authHeaders } from "./sign.mjs";
import { limiter as defaultLimiter } from "./limiter.mjs";
export const BASE = "https://api.trolley.com";
export class ToolError extends Error {}
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function buildQuery(params = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    p.append(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}
export function retryDelayMs(retryAfter, attempt) {
  if (retryAfter != null && retryAfter !== "") {
    const s = Number(retryAfter);
    if (Number.isFinite(s)) return Math.min(Math.max(s, 0) * 1000, 60000);
    const d = Date.parse(retryAfter);
    if (!Number.isNaN(d)) return Math.min(Math.max(d - Date.now(), 0), 60000);
  }
  return Math.min(1000 * 2 ** attempt, 30000);
}

// A Trolley request with no response for this long is aborted (GETs are retried); stops large pages from hanging forever.
export const REQUEST_TIMEOUT_MS = Math.max(5000, Number(process.env.TROLLEY_REQUEST_TIMEOUT_MS) || 180000);
export async function request(method, path, { query, body, fetchImpl = fetch, maxRetries = 3, limiter = defaultLimiter, onCall, on429 } = {}) {
  const accessKey = process.env.TROLLEY_ACCESS_KEY, secret = process.env.TROLLEY_SECRET_KEY;
  const missing = [!accessKey && "TROLLEY_ACCESS_KEY", !secret && "TROLLEY_SECRET_KEY"].filter(Boolean);
  if (missing.length) throw new ToolError(`Missing required env var(s): ${missing.join(", ")}. Set them in the plugin's variables (Trolley Dashboard > Settings > API Keys).`);
  const requestPath = `/v1${path}${buildQuery(query)}`;          // exactly what is sent = what is signed
  const bodyStr = body === undefined ? "" : JSON.stringify(body); // exact body string, signed and sent
  for (let attempt = 0; ; attempt++) {
    if (limiter) await limiter.take();
    onCall?.();
    const headers = authHeaders({ accessKey, secret, method, requestPath, body: bodyStr }); // re-sign each attempt (30s window)
    let res;
    try { res = await fetchImpl(BASE + requestPath, { method, headers, body: bodyStr === "" ? undefined : bodyStr, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }); }
    catch (e) {
      // Network-level failure (reset/timeout). GETs are safe to retry; writes are not retried to avoid duplicates.
      const cause = e.cause?.code || e.cause?.message || e.message;
      if (method === "GET" && attempt < Math.max(maxRetries, 5)) { await sleep(retryDelayMs(null, attempt)); continue; }
      throw new ToolError(`Network error calling Trolley (${method} ${requestPath.split("?")[0]}): ${cause}`);
    }
    if (res.status === 429) on429?.();
    if (res.status === 429 && attempt < maxRetries) { await sleep(retryDelayMs(res.headers.get("retry-after"), attempt)); continue; }
    let text;
    try { text = await res.text(); } // the timeout can also fire while the body is streaming
    catch (e) {
      if (method === "GET" && attempt < Math.max(maxRetries, 5)) { await sleep(retryDelayMs(null, attempt)); continue; }
      throw new ToolError(`Network error reading Trolley response (${method} ${requestPath.split("?")[0]}): ${e.cause?.code || e.message}`);
    }
    let json; try { json = text ? JSON.parse(text) : {}; } catch { throw new ToolError(`Trolley HTTP ${res.status}: non-JSON response: ${text.slice(0, 300)}`); }
    if (!res.ok || json.ok === false) {
      const errs = (json.errors || []).map(e => `${e.code}${e.field ? ` (${e.field})` : ""}: ${e.message}`).join("; ");
      throw new ToolError(`Trolley HTTP ${res.status}${res.status === 429 ? " (rate limited after retries)" : ""}: ${errs || "request failed"}`);
    }
    return json;
  }
}
