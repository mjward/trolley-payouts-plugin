// Local SQLite store (node:sqlite, Node >= 22.5). Holds NO PII: no names, emails, recipient ids, addresses, account numbers.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, chmodSync, existsSync, openSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { ToolError } from "./client.mjs";

export const SCHEMA_VERSION = 1;
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY, status TEXT, description TEXT, tags TEXT, amount TEXT, currency TEXT, totalPayments INTEGER,
  createdAt TEXT, sentAt TEXT, completedAt TEXT, updatedAt TEXT, returnedCount INTEGER, lastSyncedAt TEXT);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY, batchId TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  status TEXT, sourceAmount TEXT, sourceCurrency TEXT, targetAmount TEXT, targetCurrency TEXT, fees TEXT,
  payoutMethod TEXT, country TEXT, createdAt TEXT, processedAt TEXT, returnedAt TEXT, settledAt TEXT, updatedAt TEXT,
  failureReason TEXT, returnReason TEXT, lastSyncedAt TEXT, recipientId TEXT);
CREATE INDEX IF NOT EXISTS payments_batch ON payments(batchId);
CREATE INDEX IF NOT EXISTS payments_date ON payments(coalesce(processedAt, createdAt));
CREATE INDEX IF NOT EXISTS payments_status ON payments(status);
-- Recipients: email allowed (owner-approved). Never name, tax, bank/account, address, phone, DOB or government IDs.
CREATE TABLE IF NOT EXISTS recipients (
  id TEXT PRIMARY KEY, referenceId TEXT, email TEXT, country TEXT, payoutMethod TEXT, status TEXT, complianceStatus TEXT,
  isPhoneVerified INTEGER, createdAt TEXT, updatedAt TEXT, lastSyncedAt TEXT);
CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT);
-- What payout_query may read about recipients: everything except name/email.
CREATE VIEW IF NOT EXISTS recipient_facts AS SELECT id, referenceId, country, payoutMethod, status, complianceStatus, isPhoneVerified, createdAt, updatedAt FROM recipients;
`;
export const BATCH_COLS = ["id", "status", "tags", "amount", "currency", "totalPayments", "createdAt", "sentAt", "completedAt", "updatedAt", "returnedCount", "lastSyncedAt"];
export const PAYMENT_COLS = ["id", "batchId", "status", "sourceAmount", "sourceCurrency", "targetAmount", "targetCurrency", "fees", "payoutMethod", "country",
  "createdAt", "processedAt", "returnedAt", "settledAt", "updatedAt", "failureReason", "returnReason", "lastSyncedAt", "recipientId"];
export const RECIPIENT_COLS = ["id", "referenceId", "email", "country", "payoutMethod", "status", "complianceStatus", "isPhoneVerified", "createdAt", "updatedAt", "lastSyncedAt"];

export const envTag = (accessKey = process.env.TROLLEY_ACCESS_KEY) => {
  if (!accessKey) throw new ToolError("Missing required env var(s): TROLLEY_ACCESS_KEY. Set them in the plugin's variables.");
  return createHash("sha256").update(accessKey).digest("hex").slice(0, 12);
};
// One DB per environment: <TROLLEY_DB_PATH without .db>-<keyhash12>.db. The key itself is never stored.
export function dbPath(accessKey) {
  const base = process.env.TROLLEY_DB_PATH || join(homedir(), ".cache", "trolley-plugin", "trolley.db");
  return base.replace(/(\.db)?$/, `-${envTag(accessKey)}.db`);
}
const secure = p => { for (const f of [p, `${p}-wal`, `${p}-shm`]) if (existsSync(f)) chmodSync(f, 0o600); };

export function openDb({ path, readOnly = false, memory = false } = {}) {
  if (memory) { const m = new DatabaseSync(":memory:"); m.exec(SCHEMA); m.secure = () => {}; m.path = ":memory:"; return m; } // payment cache off: nothing touches disk
  path ??= dbPath();
  if (readOnly) {
    if (!existsSync(path)) throw new ToolError("No local data yet: run sync_cache (or payout_stats) first.");
    return new DatabaseSync(path, { readOnly: true, timeout: 2000 });
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) closeSync(openSync(path, "a", 0o600));
  const db = new DatabaseSync(path, { timeout: 5000 });
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;");
  db.exec(SCHEMA);
  // Additive migrations (never rebuild).
  if (db.prepare("PRAGMA table_info(recipients)").all().some(c => c.name === "name")) { // name became sensitive: drop it and its old values
    db.exec("UPDATE recipients SET name=NULL; ALTER TABLE recipients DROP COLUMN name;"); db.exec("VACUUM");
  }
  if (!db.prepare("PRAGMA table_info(payments)").all().some(c => c.name === "recipientId")) db.exec("ALTER TABLE payments ADD COLUMN recipientId TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS payments_recipient ON payments(recipientId)");
  if (!db.prepare("PRAGMA table_info(batches)").all().some(c => c.name === "description")) db.exec("ALTER TABLE batches ADD COLUMN description TEXT"); // pre-0.5.1 stores
  db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES('schemaVersion',?)").run(String(SCHEMA_VERSION));
  db.secure = () => secure(path); db.secure(); db.path = path;
  return db;
}

const CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
const codes = v => { const arr = Array.isArray(v) ? v : v ? [v] : []; const c = arr.map(x => typeof x === "string" ? x : x?.code).filter(x => typeof x === "string" && CODE.test(x)); return c.length ? c.join(",") : null; };

export const toBatchRow = (b, extra = {}) => ({
  id: b.id, status: b.status ?? null, description: b.description ?? null, tags: JSON.stringify(b.tags ?? []), amount: b.amount ?? null, currency: b.currency ?? null,
  totalPayments: b.totalPayments ?? null, createdAt: b.createdAt ?? null, sentAt: b.sentAt ?? null, completedAt: b.completedAt ?? null,
  updatedAt: b.updatedAt ?? null, ...extra,
});
export const toPaymentRow = (p, batchId, now) => ({
  id: p.id, batchId, status: p.status ?? null, sourceAmount: p.sourceAmount ?? null, sourceCurrency: p.sourceCurrency ?? null,
  targetAmount: p.targetAmount ?? null, targetCurrency: p.targetCurrency ?? null, fees: p.fees ?? null,
  payoutMethod: p.payoutMethod || p.recipient?.payoutMethod || null,
  country: p.recipient?.address?.country || p.account?.country || p.recipient?.country || null,
  createdAt: p.createdAt ?? null, processedAt: p.processedAt ?? null, returnedAt: p.returnedAt ?? null, settledAt: p.settledAt ?? null,
  updatedAt: p.updatedAt ?? null, failureReason: codes(p.errors) ?? codes(p.failureReason), returnReason: codes(p.returnedReason), lastSyncedAt: now,
  recipientId: (typeof p.recipient === "string" ? p.recipient : p.recipient?.id) ?? p.recipientId ?? null,
});

// Batch metadata upsert (keeps returnedCount/lastSyncedAt unless provided).
export function upsertBatchMeta(db, b) {
  const r = toBatchRow(b);
  db.prepare(`INSERT INTO batches(id,status,description,tags,amount,currency,totalPayments,createdAt,sentAt,completedAt,updatedAt)
    VALUES(:id,:status,:description,:tags,:amount,:currency,:totalPayments,:createdAt,:sentAt,:completedAt,:updatedAt)
    ON CONFLICT(id) DO UPDATE SET status=excluded.status,description=excluded.description,tags=excluded.tags,amount=excluded.amount,currency=excluded.currency,
    totalPayments=excluded.totalPayments,createdAt=excluded.createdAt,sentAt=excluded.sentAt,completedAt=excluded.completedAt,updatedAt=excluded.updatedAt`).run(r);
}
// Replace a batch's payment set atomically (idempotent): upsert by id, drop payments no longer present.
export function replaceBatchPayments(db, batch, payments, { returnedCount, now = new Date().toISOString() } = {}) {
  const ins = db.prepare(`INSERT INTO payments(${PAYMENT_COLS.join(",")}) VALUES(${PAYMENT_COLS.map(c => ":" + c).join(",")})
    ON CONFLICT(id) DO UPDATE SET ${PAYMENT_COLS.filter(c => c !== "id").map(c => `${c}=excluded.${c}`).join(",")}`);
  db.exec("BEGIN IMMEDIATE");
  try {
    upsertBatchMeta(db, batch);
    db.exec("CREATE TEMP TABLE IF NOT EXISTS _seen(id TEXT PRIMARY KEY)"); db.exec("DELETE FROM _seen");
    const seen = db.prepare("INSERT OR IGNORE INTO _seen(id) VALUES(?)");
    for (const p of payments) { ins.run(toPaymentRow(p, batch.id, now)); seen.run(p.id); }
    db.prepare("DELETE FROM payments WHERE batchId=? AND id NOT IN (SELECT id FROM _seen)").run(batch.id);
    const rc = returnedCount ?? payments.filter(p => p.status === "returned").length;
    db.prepare("UPDATE batches SET returnedCount=?, lastSyncedAt=? WHERE id=?").run(rc, now, batch.id);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}
export function deleteMissingBatches(db, seenIds) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("CREATE TEMP TABLE IF NOT EXISTS _sb(id TEXT PRIMARY KEY)"); db.exec("DELETE FROM _sb");
    const s = db.prepare("INSERT OR IGNORE INTO _sb(id) VALUES(?)"); for (const id of seenIds) s.run(id);
    const n = db.prepare("DELETE FROM batches WHERE id NOT IN (SELECT id FROM _sb)").run().changes;
    db.exec("COMMIT"); return Number(n);
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

// --- recipients + sync_state ---
export const getState = (db, k) => db.prepare("SELECT value FROM sync_state WHERE key=?").get(k)?.value ?? null;
export const setState = (db, k, v) => db.prepare("INSERT INTO sync_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, v == null ? null : String(v));
export const toRecipientRow = (r, now = new Date().toISOString()) => ({
  id: r.id, referenceId: r.referenceId ?? null, email: r.email ?? null,
  country: r.address?.country ?? r.country ?? null, payoutMethod: r.payoutMethod ?? null, status: r.status ?? null,
  complianceStatus: r.complianceStatus ?? r.compliance?.status ?? null,
  isPhoneVerified: typeof r.isPhoneVerified === "boolean" ? (r.isPhoneVerified ? 1 : 0) : null,
  createdAt: r.createdAt ?? null, updatedAt: r.updatedAt ?? null, lastSyncedAt: now });
export function upsertRecipient(db, r, now) {
  db.prepare(`INSERT INTO recipients(${RECIPIENT_COLS.join(",")}) VALUES(${RECIPIENT_COLS.map(c => ":" + c).join(",")})
    ON CONFLICT(id) DO UPDATE SET ${RECIPIENT_COLS.filter(c => c !== "id").map(c => `${c}=excluded.${c}`).join(",")}`).run(toRecipientRow(r, now));
}
