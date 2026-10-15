process.env.TROLLEY_BATCH_GROUPS = "Alpha,Beta";
process.env.TROLLEY_CONFIG_FILE = "/nonexistent/trolley-test-config.json"; // isolate from the machine config (e.g. phone mode)
import { test } from "node:test"; import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { openDb, getState, setState, replaceBatchPayments, upsertRecipient } from "../server/db.mjs";
import { sweepRecipients, lazyFill, WATERMARK, backfill } from "../server/recipients.mjs";
const fresh = () => openDb({ path: join(mkdtempSync(join(tmpdir(), "rc-")), "t.db") });
const rec = (id, updatedAt, extra = {}) => ({ id, updatedAt, name: "N " + id, email: id + "@x.io", status: "active", ssn: "1", taxType: "x", address: { country: "AU", street1: "s" }, phone: "+61", dob: "d", isPhoneVerified: true, ...extra });

test("schema: recipients has name/email but no sensitive columns; payments.recipientId added additively", () => {
  const db = fresh();
  const cols = db.prepare("PRAGMA table_info(recipients)").all().map(c => c.name);
  assert.ok(cols.includes("email") && !cols.includes("name"));
  for (const c of cols) assert.ok(!/ssn|tax|bank|account|address|street|postal|phone$|dob|birth|government|iban|routing|swift/i.test(c), c);
  assert.ok(db.prepare("PRAGMA table_info(payments)").all().some(c => c.name === "recipientId"));
  upsertRecipient(db, rec("R-1", "2026-10-01T00:00:00Z"));
  const row = db.prepare("SELECT * FROM recipients").get(); assert.equal(row.isPhoneVerified, 1); assert.equal(row.country, "AU"); assert.ok(!JSON.stringify(row).includes("+61"));
});
test("first sweep sets watermark to now without fetching", async () => {
  const db = fresh(); let calls = 0;
  const r = await sweepRecipients(db, { get: async () => { calls++; return {}; }, now: new Date("2026-10-16T00:00:00Z") });
  assert.equal(r.firstRun, true); assert.equal(calls, 0); assert.equal(getState(db, WATERMARK), "2026-10-16T00:00:00.000Z");
});
test("sweep: 2-min overlap, dedupe, upsert only known, advance to max updatedAt (or sweep start if empty)", async () => {
  const db = fresh(); setState(db, WATERMARK, "2026-10-15T00:00:00.000Z");
  upsertRecipient(db, rec("R-1", "2026-10-01T00:00:00Z", { status: "incomplete" }));
  let q;
  const get = async (m, path, { query }) => { q = query; return { recipients: [rec("R-1", "2026-10-15T00:01:00Z"), rec("R-1", "2026-10-15T03:00:00Z", { status: "blocked" }), rec("R-new", "2026-10-15T05:00:00Z")], meta: { pages: 1 } }; };
  const r = await sweepRecipients(db, { get, now: new Date("2026-10-16T00:00:00Z") });
  assert.equal(q.startDate, "2026-10-14T23:58:00.000Z"); assert.equal(q.endDate, "2026-10-16T00:00:00.000Z"); assert.equal(q.orderBy, "updatedAt"); assert.equal(q.sortBy, "asc");
  assert.equal(r.distinct, 2); assert.equal(r.updated, 1);
  assert.equal(db.prepare("SELECT status FROM recipients WHERE id='R-1'").get().status, "blocked");
  assert.equal(db.prepare("SELECT count(*) n FROM recipients").get().n, 1); // R-new not pulled in
  assert.equal(getState(db, WATERMARK), "2026-10-15T05:00:00Z");
  await sweepRecipients(db, { get: async () => ({ recipients: [], meta: { pages: 1 } }), now: new Date("2026-10-17T00:00:00Z") });
  assert.equal(getState(db, WATERMARK), "2026-10-17T00:00:00.000Z");
});
test("sweep failure leaves the watermark and rows untouched", async () => {
  const db = fresh(); setState(db, WATERMARK, "2026-10-15T00:00:00.000Z");
  let n = 0; const get = async () => { if (++n === 2) throw new Error("Network error"); return { recipients: [rec("R-1", "2026-10-15T09:00:00Z")], meta: { pages: 2 } }; };
  await assert.rejects(sweepRecipients(db, { get }));
  assert.equal(getState(db, WATERMARK), "2026-10-15T00:00:00.000Z");
});
test("lazy fill: only missing recipientIds are fetched; 404 stubbed; re-run is a no-op", async () => {
  const db = fresh();
  replaceBatchPayments(db, { id: "B-1", status: "complete" }, [{ id: "P-1", recipient: { id: "R-1" } }, { id: "P-2", recipient: { id: "R-2" } }, { id: "P-3", recipient: { id: "R-gone" } }, { id: "P-4", recipient: { id: "R-1" } }]);
  upsertRecipient(db, rec("R-2", "x"));
  const calls = []; const get = async (m, path) => { calls.push(path); if (path.endsWith("R-gone")) throw new Error("Trolley HTTP 404: not_found"); return { recipient: rec(path.split("/").pop(), "y") }; };
  const r = await lazyFill(db, { get }); assert.deepEqual(calls.sort(), ["/recipients/R-1", "/recipients/R-gone"]); assert.deepEqual([r.filled, r.notFound], [1, 1]);
  calls.length = 0; await lazyFill(db, { get }); assert.equal(calls.length, 0);
});
test("backfill: batches → recipients → watermark = start; resumable after a failure", async () => {
  const db = fresh(); let fail = true;
  const get = async (m, path) => {
    if (path === "/batches") return { batches: [{ id: "B-1", status: "complete", totalPayments: 1, updatedAt: "u", completedAt: "2020-01-01T00:00:00Z" }], meta: { pages: 1 } };
    if (path.endsWith("/payments")) return { payments: [{ id: "P-1", recipient: { id: "R-1" } }], meta: { pages: 1 } };
    if (fail) throw new Error("Network error"); return { recipient: rec("R-1", "z") };
  };
  const log = () => {};
  const a = await backfill({ get, db, log }); assert.equal(a.complete, false); assert.equal(getState(db, WATERMARK), null);
  const start = getState(db, "backfill.startedAt"); fail = false;
  const b = await backfill({ get, db, log }); assert.equal(b.complete, true); assert.equal(getState(db, WATERMARK), start);
  assert.equal(db.prepare("SELECT recipientId FROM payments").get().recipientId, "R-1");
});

test("migration drops an old name column and its values; sync/init/lazy fill never write a name", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const path = join(mkdtempSync(join(tmpdir(), "rc-")), "t.db");
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE recipients (id TEXT PRIMARY KEY, referenceId TEXT, name TEXT, email TEXT, country TEXT, payoutMethod TEXT, status TEXT, complianceStatus TEXT, isPhoneVerified INTEGER, createdAt TEXT, updatedAt TEXT, lastSyncedAt TEXT); INSERT INTO recipients(id,name) VALUES('R-old','Old Name');");
  old.close();
  const db = openDb({ path });
  assert.ok(!db.prepare("PRAGMA table_info(recipients)").all().some(c => c.name === "name"));
  const get = async (m, p) => {
    if (p === "/batches") return { batches: [{ id: "B-1", status: "complete", totalPayments: 1, updatedAt: "u", completedAt: "2020-01-01T00:00:00Z" }], meta: { pages: 1 } };
    if (p.endsWith("/payments")) return { payments: [{ id: "P-1", recipient: { id: "R-9", name: "Secret Person", firstName: "Secret", lastName: "Person", email: "s@x.io" } }], meta: { pages: 1 } };
    if (p === "/recipients") return { recipients: [rec("R-9", "2026-10-15T09:00:00Z", { name: "Secret Person", firstName: "Secret" })], meta: { pages: 1 } };
    return { recipient: rec("R-9", "z", { name: "Secret Person", firstName: "Secret", lastName: "Person" }) };
  };
  await backfill({ get, db, log: () => {} });
  setState(db, WATERMARK, "2026-10-15T00:00:00.000Z"); await sweepRecipients(db, { get });
  await lazyFill(db, { get });
  const raw = new DatabaseSync(path, { readOnly: true });
  for (const t of ["recipients", "payments", "batches"]) { const d = JSON.stringify(raw.prepare(`SELECT * FROM ${t}`).all()); assert.ok(!/Secret|Person|Old Name/.test(d), t); }
  raw.close(); db.close();
});
test("bulk tools never output recipient emails/names: payout_query blocks recipients; payday + stats outputs are id/count only", async () => {
  const { guardSql } = await import("../server/query.mjs");
  for (const q of ["SELECT email FROM recipients", 'SELECT * FROM "recipients"', "SELECT * FROM [Recipients]", "select * from payments p join `recipients` r on r.id=p.recipientId"])
    assert.throws(() => guardSql(q), /recipients table/);
  assert.doesNotThrow(() => guardSql("SELECT status, count(*) FROM recipient_facts GROUP BY 1"));
  const db = fresh();
  const facts = db.prepare("PRAGMA table_info(recipient_facts)").all().map(c => c.name); assert.ok(!facts.includes("email") && !facts.includes("name"));
  const { paydaySummary } = await import("../server/payday.mjs"); const { statsFromDb } = await import("../server/stats.mjs");
  const E = { id: "B-e", description: "2026-08 Alpha (aaaaaaaa-0000-4000-8000-000000000001)", createdAt: "2026-10-10T20:31:00Z", status: "processing", totalPayments: 1, updatedAt: "u" };
  const get = async (m, p) => p === "/batches" ? { batches: [E], meta: { pages: 1 } } : { payments: [{ id: "P-1", status: "processed", sourceAmount: "1.00", sourceCurrency: "USD", createdAt: "2026-10-10T20:31:00Z", recipient: { id: "R-1", email: "who@x.io", name: "Who Person" } }], meta: { pages: 1, records: 0 } };
  upsertRecipient(db, rec("R-1", "x", { email: "who@x.io" }));
  const out = JSON.stringify(await paydaySummary({}, { get, db, now: new Date("2026-10-15T09:00:00Z") })) + JSON.stringify(statsFromDb(db, { startDate: "2026-10-01T00:00:00Z", endDate: "2026-11-01T00:00:00Z" }));
  assert.ok(!/who@x\.io|Who Person/.test(out));
});
test("backfill honours config: sync off / payout off skip with no calls; recipient off skips recipients + watermark", async () => {
  let calls = 0; const get = async (m, p) => { calls++; if (p === "/batches") return { batches: [], meta: { pages: 1 } }; return {}; };
  const log = () => {};
  assert.equal((await backfill({ get, db: fresh(), log, cfg: { syncEnabled: false, paymentCache: true, recipientCache: true } })).status, "sync disabled");
  assert.equal((await backfill({ get, db: fresh(), log, cfg: { syncEnabled: true, paymentCache: false, recipientCache: true } })).status, "payment cache disabled");
  assert.equal(calls, 0);
  const db = fresh(); const r = await backfill({ get, db, log, cfg: { syncEnabled: true, paymentCache: true, recipientCache: false } });
  assert.equal(r.recipients, "recipient cache disabled"); assert.equal(getState(db, WATERMARK), null);
});
test("strategy choice and bulk fill: keeps only payment-referenced IDs, never names, resumable by page", async () => {
  const { chooseStrategy, bulkFill } = await import("../server/recipients.mjs");
  assert.equal(chooseStrategy(25000, 120000).strategy, "bulk");  // 151 pages*25 = 3775 < 25000
  assert.equal(chooseStrategy(500, 120000).strategy, "per-id");
  const db = fresh();
  replaceBatchPayments(db, { id: "B-1", status: "complete" }, [{ id: "P-1", recipient: { id: "R-a" } }, { id: "P-2", recipient: { id: "R-c" } }]);
  const all = { 1: [rec("R-a", "x", { name: "Hide Me" }), rec("R-b", "x")], 2: [rec("R-c", "x", { firstName: "Hide" }), rec("R-d", "x")] };
  let fail = true; const seen = [];
  const get = async (m, p, { query }) => { seen.push(query.page); if (query.page === 2 && fail) throw new Error("Network error"); return { recipients: all[query.page], meta: { pages: 2 } }; };
  await assert.rejects(bulkFill(db, { get }));
  assert.deepEqual(db.prepare("SELECT id FROM recipients ORDER BY id").all().map(r => r.id), ["R-a"]);
  fail = false; seen.length = 0;
  const r = await bulkFill(db, { get }); assert.deepEqual(seen, [2]); assert.equal(r.leftover, 0);
  const rows = db.prepare("SELECT * FROM recipients ORDER BY id").all(); assert.deepEqual(rows.map(x => x.id), ["R-a", "R-c"]);
  assert.ok(!/Hide/.test(JSON.stringify(rows)));
});
test("backfill progress: a line per payments page and per finished batch, with counts/elapsed/ETA; heartbeat while waiting", async () => {
  const { progressLine, heartbeat } = await import("../server/recipients.mjs");
  const lines = []; const db = fresh();
  const get = async (m, p, { query } = {}) => {
    if (p === "/batches") return { batches: [{ id: "B-1", status: "complete", totalPayments: 3, updatedAt: "u", completedAt: "2020-01-01T00:00:00Z" }, { id: "B-2", status: "complete", totalPayments: 2, updatedAt: "u", completedAt: "2020-01-01T00:00:00Z" }], meta: { pages: 1 } };
    if (p.endsWith("/payments")) { const id = p.split("/")[2]; const n = id === "B-1" ? 3 : 2; const pages = n; return { payments: [{ id: `${id}-P${query.page}`, recipient: { id: "R-1" } }], meta: { pages } }; }
    return { recipient: rec("R-1", "z") };
  };
  await backfill({ get, db, log: l => lines.push(l), concurrency: 1 });
  const pages = lines.filter(l => / page \d+\/\d+ /.test(l)), done = lines.filter(l => l.includes("batch done"));
  assert.equal(pages.length, 5); assert.equal(done.length, 2);
  assert.match(pages[0], /batch 1\/2 page 1\/3 \| 1 payments stored of ~3 queued \| \d+s elapsed \| ETA /);
  assert.match(done[1], /batch done 2\/2 \(B-2, refetch, 2 payments\) \| 5 payments stored/);
  assert.match(lines.join("\n"), /listing batches/);
  assert.equal(progressLine({ type: "page", batchIndex: 1, total: 2, page: 1, pages: 10, fetched: 100, expected: 1100 }, 60), "  batch 1/2 page 1/10 | 100 payments stored of ~1100 queued | 60s elapsed | ETA 10m");
  // heartbeat: with a fake clock, a stale status is re-printed
  let t = 0; const out = []; const hb = heartbeat(l => out.push(l), 15000, () => t);
  hb.log("x", () => "status"); t = 16000; await new Promise(r => setTimeout(r, 5100)); hb.stop();
  assert.ok(out.some(l => l.startsWith("status (waiting")));
});
