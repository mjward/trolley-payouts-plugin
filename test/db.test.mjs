process.env.TROLLEY_CONFIG_FILE ??= "/nonexistent/trolley-test-config.json"; // isolate from the machine config
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, PAYMENT_COLS, BATCH_COLS, replaceBatchPayments, dbPath, envTag } from "../server/db.mjs";
import { refresh, planBatch } from "../server/sync.mjs";
import { statsFromDb } from "../server/stats.mjs";
import { guardSql, runQuery } from "../server/query.mjs";

const tmp = () => join(mkdtempSync(join(tmpdir(), "tdb-")), "t.db");
const PII = /name|email|recipient(?!Id$)|address|street|postal|phone|ssn|dob|passport|government|iban|routing|swift|accountnum|tax|memo|note/i;

test("schema has no PII columns", () => {
  const db = openDb({ path: tmp() });
  for (const t of ["batches", "payments"]) for (const c of db.prepare(`PRAGMA table_info(${t})`).all()) assert.ok(!PII.test(c.name), `${t}.${c.name}`);
  assert.ok(!PAYMENT_COLS.some(c => PII.test(c)) && !BATCH_COLS.some(c => PII.test(c)));
  assert.equal(statSync(db.path).mode & 0o777, 0o600);
  assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  db.close();
});
test("DB path is per environment via key hash, never the key", () => {
  const a = dbPath("AK_SANDBOX_FAKE"), b = dbPath("AK_PROD_FAKE");
  assert.notEqual(a, b); assert.ok(!a.includes("AK_SANDBOX_FAKE")); assert.match(a, new RegExp(`-${envTag("AK_SANDBOX_FAKE")}\\.db$`));
});

const B = (o = {}) => ({ id: "B-1", status: "complete", tags: ["t"], amount: "30.00", currency: "USD", totalPayments: 3, createdAt: "2026-09-01T00:00:00Z", sentAt: "2026-09-01T01:00:00Z", completedAt: "2026-09-01T02:00:00Z", updatedAt: "2026-09-01T02:00:00Z", ...o });
const P = (id, status, o = {}) => ({ id, status, sourceAmount: "10.00", sourceCurrency: "USD", processedAt: "2026-09-01T01:30:00Z", createdAt: "2026-09-01T00:30:00Z",
  recipient: { id: "R-secret", email: "x@y.z", name: "Jane", address: { country: "CA", street1: "1 St" } }, memo: "private", ...o });

test("upsert is idempotent and stores no PII", () => {
  const db = openDb({ path: tmp() });
  const ps = [P("P-1", "processed"), P("P-2", "processed"), P("P-3", "failed", { errors: ["insufficient_funds"] })];
  replaceBatchPayments(db, B(), ps); replaceBatchPayments(db, B(), ps);
  assert.equal(Number(db.prepare("SELECT count(*) n FROM payments").get().n), 3);
  const dump = JSON.stringify(db.prepare("SELECT * FROM payments").all());
  for (const s of ["x@y.z", "Jane", "1 St", "private"]) assert.ok(!dump.includes(s), s); // recipientId (opaque) is allowed
  assert.equal(db.prepare("SELECT country, failureReason FROM payments WHERE id='P-3'").get().failureReason, "insufficient_funds");
  replaceBatchPayments(db, B(), ps.slice(0, 2)); // payment removed remotely -> removed locally
  assert.equal(Number(db.prepare("SELECT count(*) n FROM payments").get().n), 2);
  db.close();
});

test("late return: returnedCount check triggers refetch, row updates, stats change", async () => {
  const db = openDb({ path: tmp() });
  const now = Date.parse("2026-10-01T00:00:00Z");
  let payments = [P("P-1", "processed"), P("P-2", "processed"), P("P-3", "processed")];
  const calls = [];
  const get = async (m, path, { query }) => {
    calls.push(`${path}?${query.status || ""}`);
    if (path === "/batches") return { batches: [B()], meta: { pages: 1 } };
    const list = query.status ? payments.filter(p => p.status === query.status) : payments;
    return { payments: list.slice(0, query.pageSize), meta: { pages: 1, records: list.length } };
  };
  const realNow = Date.now; Date.now = () => now;
  try {
    await refresh({}, { get, db });                                   // first sync: refetch
    const range = { startDate: "2026-09-01T00:00:00Z", endDate: "2026-10-01T00:00:00Z" };
    assert.equal(statsFromDb(db, range).byStatus.returned, undefined);
    calls.length = 0; await refresh({}, { get, db });                  // unchanged: only a cheap check
    assert.deepEqual(calls, ["/batches?", "/batches/B-1/payments?returned"]);
    payments = payments.map(p => p.id === "P-2" ? { ...p, status: "returned", returnedAt: "2026-09-20T00:00:00Z" } : p); // batch updatedAt unchanged!
    calls.length = 0; const r = await refresh({}, { get, db });
    assert.equal(r.checkChanged, 1); assert.equal(r.refetched, 1);
    assert.equal(db.prepare("SELECT status FROM payments WHERE id='P-2'").get().status, "returned");
    const s = statsFromDb(db, range); assert.equal(s.byStatus.returned, 1); assert.equal(s.rates.combinedFailRate, 0.3333);
    assert.equal(Number(db.prepare("SELECT returnedCount FROM batches").get().returnedCount), 1);
  } finally { Date.now = realNow; db.close(); }
});

test("planBatch rules", () => {
  const now = Date.parse("2026-10-01T00:00:00Z"); const b = B(); const stored = { lastSyncedAt: "x", updatedAt: b.updatedAt, status: b.status, returnedCount: 0 };
  assert.equal(planBatch({ ...b, status: "processing" }, stored, { now }), "refetch");
  assert.equal(planBatch(b, null, { now }), "refetch");
  assert.equal(planBatch(b, stored, { now }), "check");
  assert.equal(planBatch(b, { ...stored, updatedAt: "other" }, { now }), "refetch");
  assert.equal(planBatch({ ...b, completedAt: "2026-01-01T00:00:00Z" }, stored, { now }), "skip");      // >120d: final
  assert.equal(planBatch({ ...b, completedAt: "2026-01-01T00:00:00Z" }, stored, { now, full: true }), "check");
  assert.equal(planBatch(b, stored, { now, force: true }), "refetch");
});

test("SQL guard rejects writes, PRAGMA, ATTACH, multi-statement", async () => {
  for (const q of ["DELETE FROM payments", "PRAGMA table_info(payments)", "ATTACH 'x.db' AS x", "SELECT 1; DROP TABLE payments",
    "UPDATE payments SET status='x'", "WITH x AS (SELECT 1) INSERT INTO meta VALUES(1,1)", "SELECT load_extension('x')", "VACUUM"])
    assert.throws(() => guardSql(q), /not allowed|single statement|Only SELECT/, q);
  assert.equal(guardSql("SELECT ';' AS semi, 'delete' AS word FROM payments;"), "SELECT ';' AS semi, 'delete' AS word FROM payments");
  const path = tmp(); const db = openDb({ path }); replaceBatchPayments(db, B(), [P("P-1", "processed"), P("P-2", "returned")]); db.close();
  const r = await runQuery("SELECT status, count(*) n FROM payments GROUP BY status ORDER BY status", { path });
  assert.deepEqual(r.rows, [{ status: "processed", n: 1 }, { status: "returned", n: 1 }]);
  const capped = await runQuery("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c LIMIT 5000) SELECT x FROM c", { path });
  assert.equal(capped.rowCount, 1000); assert.equal(capped.truncated, true);
  await assert.rejects(runQuery("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c", { path, timeoutMs: 300 }), /exceeded/);
  await assert.rejects(runQuery("SELECT * FROM pragma_table_info('payments')", { path }), /not allowed/); // passes text guard, blocked by authorizer
});
