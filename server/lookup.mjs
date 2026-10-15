import { badge } from "./badge.mjs";
// recipient_lookup: resolve a pasted Trolley recipient ID or email to a trimmed summary. GET only.
import { request as defaultRequest, ToolError } from "./client.mjs";
import { toRecipient } from "./shape.mjs";

export const ID_RE = /^R-[A-Za-z0-9]{6,40}$/;
export const EMAIL_RE = /^[^\s@<>()"]+@[^\s@<>()"]+\.[^\s@<>()"]+$/;

export function normalizeInput(raw) {
  let s = String(raw ?? "").trim();
  const angle = /<([^<>]+)>/.exec(s); if (angle) s = angle[1].trim();        // "Name <a@b.c>" or "<a@b.c>"
  s = s.replace(/^<+|>+$/g, "").replace(/^mailto:/i, "").trim();
  s = s.replace(/^["']+|["']+$/g, "").replace(/[.,;]+$/, "").trim();
  return s;
}
export const toLookupSummary = r => {
  const s = toRecipient(r);
  return { id: s.id, referenceId: s.referenceId, email: s.email, status: s.status, statusBadge: badge(s.status), complianceStatus: s.complianceStatus, complianceBadge: badge(s.complianceStatus),
    payoutMethod: s.payoutMethod, country: s.country, isPhoneVerified: typeof r.isPhoneVerified === "boolean" ? r.isPhoneVerified : null, createdAt: s.createdAt };
};
async function byId(id, get) {
  if (!/^[A-Za-z0-9-]{3,64}$/.test(id)) return null;
  try { return (await get("GET", `/recipients/${encodeURIComponent(id)}`)).recipient || null; }
  catch (e) { if (/HTTP 404|not_found/.test(e.message)) return null; throw e; }
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SEARCH_CAP = 10;
export function routeFor(input) {
  if (UUID_RE.test(input)) return "referenceId";
  if (input.includes("@")) return "email";
  if (/^R-/i.test(input)) return "id";
  return "search";
}
// Routing: UUID uses ?referenceId= (exact), "@" uses ?email= (exact, case-insensitive), R- uses /recipients/:id, and anything else uses ?search=
// (Trolley's case-insensitive prefix match on name, email user/domain and referenceId). Branches 1-3 never fall through to search.
// cache: optional { get(id), put(recipient) }, the recipients table: email allowed (owner-approved); never name or other sensitive fields.
// Live is tried first so the data is current. If the live call fails (not a 404), the cached row is returned with source:"cache".
// Both paths return email, referenceId, ID and statuses, never a name. Name still works as SEARCH INPUT. There's no includeSensitive option.
export async function recipientLookup({ query } = {}, { get = defaultRequest, cache } = {}) {
  const input = normalizeInput(query);
  if (!input) throw new ToolError("Provide a Trolley recipient ID (R-…), a reference ID (UUID), an email address, or a search term.");
  const route = routeFor(input);
  const list = async q => (await get("GET", "/recipients", { query: { ...q, page: 1, pageSize: 100 } })).recipients || [];
  const one = (matchedBy, r) => { cache?.put?.(r); return { matchedBy, recipient: toLookupSummary(r) }; };
  try {
    if (route === "id") {
      const r = await byId(input, get);
      if (r) return one("id", r);
      throw new ToolError(`No recipient found with ID ${input} in this environment.`);
    }
    if (route === "referenceId") {
      const exact = (await list({ referenceId: input })).filter(r => r.referenceId != null && String(r.referenceId).toLowerCase() === input.toLowerCase());
      if (exact.length === 1) return one("referenceId", exact[0]);
      if (exact.length > 1) throw new ToolError(`Ambiguous: ${exact.length} recipients have referenceId ${input} (${exact.map(r => r.id).join(", ")}).`);
      throw new ToolError(`No recipient found with referenceId ${input} in this environment.`);
    }
    if (route === "email") {
      const want = input.toLowerCase(), found = new Map();
      for (const q of input === want ? [input] : [input, want]) for (const r of await list({ email: q })) if (String(r.email || "").toLowerCase() === want) found.set(r.id, r);
      const exact = [...found.values()];
      if (exact.length === 1) return one("email", exact[0]);
      if (exact.length > 1) throw new ToolError(`Ambiguous: ${exact.length} recipients share that email (${exact.map(r => r.id).join(", ")}). Look up by ID instead.`);
      throw new ToolError(`No recipient found with email ${input} in this environment.`);
    }
    const res = await get("GET", "/recipients", { query: { search: input, page: 1, pageSize: SEARCH_CAP } });
    const hits = res.recipients || [], count = res.meta?.records ?? hits.length;
    if (count === 0 || hits.length === 0) throw new ToolError(`No recipient matches search "${input}" in this environment.`);
    if (count === 1 && hits.length === 1) return one("search", hits[0]);
    return { matchedBy: "search", count, shown: Math.min(hits.length, SEARCH_CAP), candidates: hits.slice(0, SEARCH_CAP).map(toLookupSummary),
      note: count > SEARCH_CAP ? `${count} matches; showing the first ${SEARCH_CAP}. Refine the search or paste an ID, email or reference ID.` : "Several matches; pick one by ID." };
  } catch (e) {
    if (e instanceof ToolError || route !== "id" || !cache?.get) throw e;
    const c = cache.get(input); // live failed (network or 5xx): serve the non-PII cached row
    if (c) return { matchedBy: "id", source: "cache", note: `Live lookup failed (${e.message}); showing the cached copy (last synced ${c.lastSyncedAt ?? "unknown"}).`, recipient: { id: c.id, referenceId: c.referenceId, email: c.email, status: c.status, statusBadge: badge(c.status), complianceStatus: c.complianceStatus, complianceBadge: badge(c.complianceStatus), payoutMethod: c.payoutMethod, country: c.country, isPhoneVerified: c.isPhoneVerified, createdAt: c.createdAt } };
    throw e;
  }
}

export const recipientLookupTool = {
  name: "recipient_lookup",
  description: "Read-only. Look up a Trolley recipient. Routing: UUID (8-4-4-4-12) uses GET /recipients?referenceId= (exact). Input containing @ uses ?email= (exact, case-insensitive). R-… uses GET /recipients/:id. Anything else uses ?search= (case-insensitive prefix match on name, email user or domain, and referenceId): one hit returns it, several return up to 10 trimmed candidates plus a count. The first three return a clear not-found and never fall through to search. Returns {matchedBy: id|email|referenceId|search, recipient} or {matchedBy:'search', count, candidates}. Output: id, referenceId, email, statuses, payoutMethod, country, isPhoneVerified, createdAt. Never a name (sensitive) or other sensitive fields. Name works as search input.",
  inputSchema: { type: "object", properties: { query: { type: "string", description: "Recipient ID (R-…), reference ID, or email, as pasted" } }, required: ["query"] },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  run: async a => {
    const { openDb } = await import("./db.mjs"); const { recipientCache } = await import("./recipients.mjs");
    const { loadConfig } = await import("./config.mjs");
    let db = null; if (loadConfig().recipientCache) { try { db = openDb(); } catch { db = null; } } // off: live only, no reads/writes
    try { return await recipientLookup(a, db ? { cache: recipientCache(db) } : {}); } finally { db?.close(); }
  },
};
