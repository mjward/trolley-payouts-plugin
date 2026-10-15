// payout_query: read-only SQL over the local store. Runs in a child process (SIGKILL on timeout; a worker thread
// cannot interrupt a running native SQLite statement), DB opened readOnly,
// SQLite authorizer allows only SELECT/READ/FUNCTION/RECURSIVE, plus a textual guard.
import { spawn } from "node:child_process";
import { ToolError } from "./client.mjs";
import { dbPath } from "./db.mjs";

export const ROW_CAP = 1000;
export const QUERY_TIMEOUT_MS = Number(process.env.TROLLEY_QUERY_TIMEOUT_MS) > 0 ? Number(process.env.TROLLEY_QUERY_TIMEOUT_MS) : 5000;
const FORBIDDEN = /\b(pragma|attach|detach|insert|update|delete|replace|create|drop|alter|vacuum|reindex|analyze|begin|commit|rollback|savepoint|release|load_extension|readfile|writefile)\b/i;

export function stripSql(sql) { // remove comments and string/identifier literals for the guard
  return sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
}
export function guardSql(sql) {
  if (typeof sql !== "string" || !sql.trim()) throw new ToolError("sql is required");
  const s = stripSql(sql).trim().replace(/;\s*$/, "");
  if (s.includes(";")) throw new ToolError("Only a single statement is allowed.");
  if (!/^(select|with)\b/i.test(s)) throw new ToolError("Only SELECT / WITH queries are allowed.");
  // Bulk tools never output recipient names or emails. The recipients table is off-limits (any quoting, even inside strings); use recipient_facts.
  if (/recipients/i.test(sql)) throw new ToolError("payout_query can't read the recipients table (it holds names and emails). Use the recipient_facts view (no name/email), or /recipient for one person.");
  const m = FORBIDDEN.exec(s); if (m) throw new ToolError(`Keyword not allowed in payout_query: ${m[1].toUpperCase()}`);
  return sql.trim().replace(/;\s*$/, "");
}

const WORKER_SRC = `
let input = ""; process.stdin.on("data", d => input += d); process.stdin.on("end", () => { const workerData = JSON.parse(input); const parentPort = { postMessage: m => process.stdout.write(JSON.stringify(m)) };
const { DatabaseSync, constants: C } = require("node:sqlite");
const main = () => {};
try {
  const db = new DatabaseSync(workerData.path, { readOnly: true, timeout: 1000 });
  const ALLOW = new Set([C.SQLITE_SELECT, C.SQLITE_READ, C.SQLITE_FUNCTION, C.SQLITE_RECURSIVE]);
  const BAD_FN = /^(load_extension|readfile|writefile|edit|fts3_tokenizer)$/i;
  db.setAuthorizer((action, a1, a2) => {
    if (!ALLOW.has(action)) return C.SQLITE_DENY;
    if (action === C.SQLITE_FUNCTION && BAD_FN.test(a2 || a1 || "")) return C.SQLITE_DENY;
    if (action === C.SQLITE_READ && a1 === "meta") return C.SQLITE_OK;
    return C.SQLITE_OK;
  });
  const st = db.prepare(workerData.sql);
  const rows = []; let truncated = false;
  for (const r of st.iterate(workerData.params || {})) { if (rows.length >= workerData.cap) { truncated = true; break; } rows.push(r); }
  const conv = v => typeof v === "bigint" ? (v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= -BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString()) : v;
  parentPort.postMessage({ ok: true, columns: rows[0] ? Object.keys(rows[0]) : st.columns().map(c => c.name), rows: rows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, conv(v)]))), truncated });
  db.close();
} catch (e) { parentPort.postMessage({ ok: false, error: e.message }); }
});
`;

export function runQuery(sql, { params, path = dbPath(), timeoutMs = QUERY_TIMEOUT_MS, cap = ROW_CAP } = {}) {
  const q = guardSql(sql);
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, ["--no-warnings", "-e", WORKER_SRC], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "" } });
    let out = "", done = false;
    const finish = fn => { if (!done) { done = true; clearTimeout(timer); fn(); } };
    const timer = setTimeout(() => finish(() => { child.kill("SIGKILL"); reject(new ToolError(`Query exceeded ${timeoutMs} ms and was cancelled.`)); }), timeoutMs);
    child.stdout.on("data", d => out += d);
    child.on("error", e => finish(() => reject(new ToolError(`SQL error: ${e.message}`))));
    child.on("close", () => finish(() => {
      let m; try { m = JSON.parse(out); } catch { return reject(new ToolError("SQL error: query process failed")); }
      if (!m.ok) return reject(new ToolError(/not authorized/i.test(m.error) ? "Query not allowed: read-only SELECT on batches/payments only." : `SQL error: ${m.error}`));
      resolve({ columns: m.columns, rows: m.rows, rowCount: m.rows.length, truncated: m.truncated, rowCap: cap, elapsedMs: Date.now() - t0 });
    }));
    child.stdin.end(JSON.stringify({ path, sql: q, params, cap }));
  });
}

export const QUERY_SCHEMA_DOC = `Tables (local copy, no PII; amounts are decimal TEXT, timestamps ISO-8601 UTC TEXT):
batches(id PK, status, tags JSON-array TEXT, amount, currency, totalPayments, createdAt, sentAt, completedAt, updatedAt, returnedCount, lastSyncedAt)
payments(id PK, batchId FK->batches.id, status [pending|processing|processed|failed|returned], sourceAmount, sourceCurrency, targetAmount, targetCurrency, fees, payoutMethod, country, createdAt, processedAt, returnedAt, settledAt, updatedAt, failureReason, returnReason, lastSyncedAt)
meta(key, value) e.g. lastSyncAt. payments.recipientId is an opaque R- id.
recipient_facts(id, referenceId, country, payoutMethod, status, complianceStatus, isPhoneVerified, createdAt, updatedAt): recipient attributes without email or name. The recipients table itself is blocked here; use /recipient to look up one person.
sync_state(key, value), e.g. recipients.updatedAtWatermark.
Use CAST(sourceAmount AS REAL) for approximate sums; payout_stats gives exact sums. Payment date convention: coalesce(processedAt, createdAt).`;

export const payoutQueryTool = {
  name: "payout_query",
  description: `Read-only SQL (single SELECT/WITH statement) over the local Trolley store; run sync_cache first if data may be stale (see meta.lastSyncAt). Row cap ${ROW_CAP}, timeout ${QUERY_TIMEOUT_MS} ms. No PRAGMA/ATTACH/writes.\n${QUERY_SCHEMA_DOC}\nExample: SELECT substr(coalesce(processedAt,createdAt),1,7) month, payoutMethod, count(*) n, round(1.0*sum(status IN ('failed','returned'))/count(*),4) failRate FROM payments GROUP BY 1,2 ORDER BY 1,2`,
  inputSchema: { type: "object", properties: { sql: { type: "string" }, params: { type: "object", description: "Named parameters (:name)" } }, required: ["sql"] },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  run: async a => {
    const { loadConfig } = await import("./config.mjs");
    if (!loadConfig().paymentCache) throw new ToolError("payout_query needs the local payment cache, which is disabled (TROLLEY_PAYMENT_CACHE off). Use payout_stats or payday_summary, which go live.");
    return runQuery(a.sql, { params: a.params });
  },
};
