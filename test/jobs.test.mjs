process.env.TROLLEY_BATCH_GROUPS = "Alpha,Beta";
process.env.TROLLEY_CONFIG_FILE = "/nonexistent/trolley-test-config.json";
import { test } from "node:test"; import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { openDb, getState, setState, upsertBatchMeta } from "../server/db.mjs";
import { WATERMARK } from "../server/recipients.mjs";
import { paymentDelta, returnedSweep, runJob, acquireLock, rotate, PAY_WM, RETURNED_AT, returnedDue, paydayToday } from "../server/jobs.mjs";
import { plist } from "../server/schedule.mjs";
const dir = () => mkdtempSync(join(tmpdir(), "jobs-"));
const fresh = () => openDb({ path: join(dir(), "t.db") });
const ALL = { syncEnabled: true, paymentCache: true, recipientCache: true };
const pay = (id, updatedAt, status = "processed", batch = "B-1") => ({ id, updatedAt, status, batch: { id: batch }, recipient: { id: "R-" + id, name: "Secret Name", email: "x@y" }, sourceAmount: "1.00" });
const pager = pages => async (m, path, { query } = {}) => { assert.equal(m, "GET"); if (path.startsWith("/batches/B-")) return { batch: { id: path.split("/")[2], description: "x" } };
  assert.equal(path, "/payments"); assert.equal(query.orderBy, "updatedAt"); assert.equal(query.sortBy, "desc"); return { payments: pages[query.page - 1] ?? [], meta: { pages: pages.length } }; };

test("payment delta: first run sets the watermark (from backfill start) without fetching", async () => {
  const db = fresh(); setState(db, "backfill.startedAt", "2026-10-15T00:00:00.000Z"); let calls = 0;
  const r = await paymentDelta(db, { get: async () => { calls++; return {}; } });
  assert.equal(r.firstRun, true); assert.equal(calls, 0); assert.equal(getState(db, PAY_WM), "2026-10-15T00:00:00.000Z");
});
test("payment delta: 2-min overlap, stops paging at the floor, dedupes, upserts idempotently, advances to max updatedAt", async () => {
  const db = fresh(); setState(db, PAY_WM, "2026-10-15T10:00:00.000Z");
  const pages = [[pay("P-1", "2026-10-15T12:00:00Z", "returned"), pay("P-2", "2026-10-15T11:00:00Z")], [pay("P-3", "2026-10-15T09:59:00Z"), pay("P-old", "2026-10-15T09:57:59Z")], [pay("never", "2026-01-01T00:00:00Z")]];
  let seenPages = 0; const g = pager(pages); const get = async (m, p, o) => { if (p === "/payments") seenPages = Math.max(seenPages, o.query.page); return g(m, p, o); };
  const r = await paymentDelta(db, { get, pageSize: 2 });
  assert.equal(seenPages, 2); // reached the floor on page 2
  assert.equal(r.fetched, 3); assert.equal(r.inserted, 3); assert.equal(r.newBatches, 1);
  assert.equal(getState(db, PAY_WM), "2026-10-15T12:00:00Z");
  assert.ok(db.prepare("SELECT 1 FROM payments WHERE id='P-3'").get()); // inside the overlap
  assert.ok(!db.prepare("SELECT 1 FROM payments WHERE id='P-old'").get());
  assert.equal(db.prepare("SELECT returnedCount n FROM batches WHERE id='B-1'").get().n, 1);
  assert.ok(!JSON.stringify(db.prepare("SELECT * FROM payments").all()).includes("Secret"));
  // re-run over the same data: idempotent
  setState(db, PAY_WM, "2026-10-15T10:00:00.000Z");
  const r2 = await paymentDelta(db, { get: pager(pages), pageSize: 2 });
  assert.equal(r2.inserted, 0); assert.equal(r2.unchanged, 3); assert.equal(db.prepare("SELECT count(*) n FROM payments").get().n, 3);
});
test("payment delta: failure or empty never moves the watermark backwards / forwards wrongly", async () => {
  const db = fresh(); setState(db, PAY_WM, "2026-10-15T10:00:00.000Z");
  let n = 0; await assert.rejects(paymentDelta(db, { get: async () => { if (++n === 2) throw new Error("timeout"); return { payments: [pay("P-1", "2026-10-15T12:00:00Z"), pay("P-2", "2026-10-15T11:00:00Z")], meta: { pages: 3 } }; }, pageSize: 2 }));
  assert.equal(getState(db, PAY_WM), "2026-10-15T10:00:00.000Z"); assert.equal(db.prepare("SELECT count(*) n FROM payments").get().n, 0);
  await paymentDelta(db, { get: pager([[pay("P-x", "2026-10-15T09:00:00Z")]]) });
  assert.equal(getState(db, PAY_WM), "2026-10-15T10:00:00.000Z");
  const d = await paymentDelta(db, { get: pager([[pay("P-y", "2026-10-15T13:00:00Z")]]), dryRun: true });
  assert.equal(d.wouldAdvanceTo, "2026-10-15T13:00:00Z"); assert.equal(getState(db, PAY_WM), "2026-10-15T10:00:00.000Z"); assert.equal(db.prepare("SELECT count(*) n FROM payments").get().n, 0);
});
test("returned sweep: status=returned on batches from the last 90 days only; upserts late returns; due every 6 h", async () => {
  const db = fresh(); const now = new Date("2026-10-16T00:00:00Z");
  upsertBatchMeta(db, { id: "B-sep", createdAt: "2026-09-10T00:00:00Z" }); upsertBatchMeta(db, { id: "B-old", createdAt: "2026-05-01T00:00:00Z" });
  db.prepare("INSERT INTO payments(id,batchId,status,updatedAt) VALUES('P-1','B-sep','processed','2026-09-15T00:00:00Z')").run();
  const asked = [];
  const get = async (m, path, { query }) => {
    if (path === "/batches") return { batches: [{ id: "B-new", createdAt: "2026-10-10T00:00:00Z" }], meta: { pages: 1 } };
    asked.push(path); assert.equal(query.status, "returned");
    if (path === "/batches/B-sep/payments") return { payments: [pay("P-1", "2026-10-15T01:02:38Z", "returned", "B-sep")], meta: { pages: 1 } };
    if (path === "/batches/B-new") return { batch: { id: "B-new" } };
    return { payments: [], meta: { pages: 1 } };
  };
  assert.equal(returnedDue(db, now), true);
  const r = await returnedSweep(db, { get, now });
  assert.deepEqual(asked.sort(), ["/batches/B-new/payments", "/batches/B-sep/payments"]);
  assert.equal(r.updated, 1); assert.equal(db.prepare("SELECT status FROM payments WHERE id='P-1'").get().status, "returned");
  assert.equal(db.prepare("SELECT returnedCount n FROM batches WHERE id='B-sep'").get().n, 1);
  assert.equal(returnedDue(db, new Date("2026-10-16T03:00:00Z")), false); assert.equal(returnedDue(db, new Date("2026-10-16T06:00:00Z")), true);
});
test("lock: second job skips while held; stale lock (dead pid) is reclaimed; backfill process blocks", async () => {
  const d = dir(), lock = join(d, "sync.lock"), db = fresh(); setState(db, PAY_WM, "2026-10-15T10:00:00.000Z");
  const rel = acquireLock(lock, { label: "recipients-sync" }); assert.ok(rel);
  let calls = 0; const get = async () => { calls++; return { payments: [], meta: { pages: 1 } }; };
  const r = await runJob("payments", { get, cfg: ALL, db, lock, backfillPids: () => [] });
  assert.equal(r.skipped, true); assert.match(r.reason, /lock held by recipients-sync/); assert.equal(calls, 0);
  rel(); assert.ok(!existsSync(lock));
  writeFileSync(lock, JSON.stringify({ pid: 999999, label: "dead" }));
  const ok = await runJob("payments", { get, cfg: ALL, db, lock, backfillPids: () => [], now: new Date("2026-10-15T12:00:00Z") });
  assert.ok(!ok.skipped); assert.ok(!existsSync(lock));
  const b = await runJob("payments", { get, cfg: ALL, db, lock, backfillPids: () => [33926] });
  assert.match(b.reason, /backfill running/);
});
test("jobs respect config switches", async () => {
  const db = fresh(); const get = async () => { throw new Error("must not fetch"); };
  assert.equal((await runJob("payments", { get, db, cfg: { ...ALL, syncEnabled: false } })).reason, "sync disabled");
  assert.equal((await runJob("payments", { get, db, cfg: { ...ALL, paymentCache: false } })).reason, "payment cache off");
  assert.equal((await runJob("recipients", { get, db, cfg: { ...ALL, recipientCache: false } })).reason, "recipient cache off");
});
test("recipient sync skips payday days without advancing the watermark", async () => {
  const db = fresh(); setState(db, WATERMARK, "2026-10-10T00:00:00.000Z"); const lock = join(dir(), "l");
  const r = await runJob("recipients", { get: async () => ({ batches: [] }), db, cfg: ALL, lock, backfillPids: () => [], now: new Date("2026-10-15T02:00:00Z") }); // 15th Melbourne
  assert.match(r.reason, /payday day/); assert.equal(getState(db, WATERMARK), "2026-10-10T00:00:00.000Z");
  const live = await paydayToday(db, { now: new Date("2026-10-12T02:00:00Z"), get: async () => ({ batches: [{ description: "2026-08 Alpha payout", createdAt: "2026-10-12T01:00:00Z" }] }) });
  assert.equal(live.payday, true);
  const r2 = await runJob("recipients", { get: async (m, p) => (p === "/batches" ? { batches: [] } : { recipients: [], meta: { pages: 1 } }), db, cfg: ALL, lock, backfillPids: () => [], now: new Date("2026-10-20T02:00:00Z") });
  assert.equal(r2.sweep.watermark, "2026-10-20T02:00:00.000Z");
});
test("log rotation and plists", () => {
  const d = dir(), f = join(d, "payment-sync.log"); writeFileSync(f, "x".repeat(20));
  assert.equal(rotate(f, { maxBytes: 10 }), true); assert.ok(existsSync(f + ".1")); assert.ok(!existsSync(f));
  const p = plist("payments", { plugin: "/P", home: "/home/alex", user: "alex" });
  assert.match(p, /<key>UserName<\/key><string>alex<\/string>/); assert.match(p, /<key>Minute<\/key><integer>7<\/integer>/); assert.ok(!/KEY|SECRET/.test(p));
  assert.ok(!plist("recipients", { plugin: "/P", daemon: false }).includes("UserName"));
  assert.equal((plist("recipients", { plugin: "/P" }).match(/<key>Hour<\/key>/g) || []).length, 4);
});
