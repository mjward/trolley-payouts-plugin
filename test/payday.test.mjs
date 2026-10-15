process.env.TROLLEY_BATCH_GROUPS = "Alpha,Beta";
process.env.TROLLEY_CONFIG_FILE ??= "/nonexistent/trolley-test-config.json"; // isolate from the machine config
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCycle, cycleWindow, classify, statusFlag, NOT_YET, paydaySummary, zonedMidnightUtc } from "../server/payday.mjs";
import { openDb } from "../server/db.mjs";

const at = iso => new Date(iso);
test("default cycle: most recent 15th on or before today (Melbourne)", () => {
  assert.deepEqual(resolveCycle(undefined, at("2026-10-15T09:00:00Z")), { year: 2026, month: 10 }); // 15 Oct 20:00 AEDT
  assert.deepEqual(resolveCycle(undefined, at("2026-10-14T12:59:00Z")), { year: 2026, month: 9 });  // 14 Oct 23:59 AEDT
  assert.deepEqual(resolveCycle(undefined, at("2026-10-14T13:00:00Z")), { year: 2026, month: 10 }); // 15 Oct 00:00 AEDT (UTC still 14th)
  assert.deepEqual(resolveCycle(undefined, at("2027-01-10T00:00:00Z")), { year: 2026, month: 12 }); // Jan rollover
});
test("month arg: names, abbrevs, case, explicit year, most recent occurrence", () => {
  const now = at("2026-10-15T09:00:00Z");
  assert.deepEqual(resolveCycle("Sep", now), { year: 2026, month: 9 });
  assert.deepEqual(resolveCycle("SEPTEMBER", now), { year: 2026, month: 9 });
  assert.deepEqual(resolveCycle("oct", now), { year: 2026, month: 10 });
  assert.deepEqual(resolveCycle("Nov", now), { year: 2025, month: 11 });
  assert.deepEqual(resolveCycle("Oct", at("2026-10-10T00:00:00Z")), { year: 2025, month: 10 }); // before the 15th
  assert.deepEqual(resolveCycle("Oct 2026", now), { year: 2026, month: 10 });
  assert.deepEqual(resolveCycle("2026-04", now), { year: 2026, month: 4 });
  assert.deepEqual(resolveCycle("Dec", at("2027-01-20T00:00:00Z")), { year: 2026, month: 12 });
  assert.throws(() => resolveCycle("Smarch", now), /Unknown month|Couldn't read/);
  assert.throws(() => resolveCycle("Ja", now) && resolveCycle("Janu-ary", now));
});
test("window is 8th 00:00 .. 16th 00:00 Melbourne, DST-aware", () => {
  const w = cycleWindow({ year: 2026, month: 10 });
  assert.equal(w.start.toISOString(), "2026-10-07T13:00:00.000Z"); // AEDT (+11)
  assert.equal(w.end.toISOString(), "2026-10-15T13:00:00.000Z");
  assert.equal(cycleWindow({ year: 2026, month: 6 }).start.toISOString(), "2026-06-07T14:00:00.000Z"); // AEST (+10)
  assert.equal(zonedMidnightUtc(2026, 4, 5).toISOString(), "2026-04-04T13:00:00.000Z"); // DST ends 5 Apr 03:00 -> midnight still AEDT
});
const B = (id, description, createdAt, status = "complete") => ({ id, description, createdAt, status, updatedAt: createdAt, completedAt: createdAt, totalPayments: 2, currency: "USD", tags: [] });
test("batch identification by description within the window", () => {
  const w = cycleWindow({ year: 2026, month: 10 });
  const k = classify([
    B("B-e1", "2026-08 Alpha (aaaaaaaa-0000-4000-8000-000000000001)", "2026-10-10T20:31:00Z"),
    B("B-m1", "2026-10 Beta (aaaaaaaa-0000-4000-8000-000000000002)", "2026-10-10T20:31:00Z"),
    B("B-x", "Payouts on 7 Oct 2026 #743", "2026-10-07T06:00:00Z"),
    B("B-late", "2026-10 Beta (aaaaaaaa-0000-4000-8000-000000000003)", "2026-10-17T00:31:00Z"), // re-run after payday: out of window
    B("B-adhoc", "ACME BETA PAYOUT 09 OCT 26", "2026-10-09T03:25:00Z")], w);
  assert.deepEqual(k.Alpha.map(b => b.id), ["B-e1"]); assert.deepEqual(k.Beta.map(b => b.id), ["B-m1"]);
});
test("flag wording", () => {
  assert.equal(statusFlag("open"), "not yet in waiting approval"); assert.equal(NOT_YET, "not yet in waiting approval");
  for (const s of ["awaiting_approval", "processing", "complete", "failed"]) assert.equal(statusFlag(s), null);
});
test("summary: per batch + combined, missing batch note, never says pending", async () => {
  const db = openDb({ path: join(mkdtempSync(join(tmpdir(), "pd-")), "t.db") });
  const E = B("B-e1", "2026-08 Alpha (aaaaaaaa-0000-4000-8000-000000000001)", "2026-10-10T20:31:00Z", "open");
  const P = (id, status, amt) => ({ id, status, sourceAmount: amt, sourceCurrency: "USD", createdAt: "2026-10-10T20:31:00Z" });
  const get = async (m, path) => path === "/batches" ? { batches: [E], meta: { pages: 1 } } : { payments: [P("P-1", "processed", "10.00"), P("P-2", "failed", "2.50")], meta: { pages: 1, records: 0 } };
  const r = await paydaySummary({}, { get, db, now: at("2026-10-15T09:00:00Z") });
  assert.equal(r.payday, "2026-10-15"); assert.equal(r.batches.Alpha.flag, NOT_YET); assert.equal(r.batches.Beta, null);
  assert.ok(r.notes.some(n => /Beta batch not found/.test(n)));
  assert.deepEqual(r.combined, { totalPayments: 2, totalAmount: { USD: "12.50" }, successful: 1, failed: 1, returned: 0, otherStatuses: {} });
  assert.ok(!/pending/i.test(JSON.stringify(r)));
  assert.match(r.batches.Alpha.createdAtMelbourne, /11 Oct 2026.*07:31/);
  db.close();
});

// --- regressions: bug "no-arg /payday returned Sep on 15 Oct" ---
import { paydayConfig, cycleWindow as cw2, resolveCycle as rc2 } from "../server/payday.mjs";
test("15 Oct 00:30 Melbourne (still 14 Oct in UTC) resolves to the Oct cycle", () => {
  assert.deepEqual(rc2(null, new Date("2026-10-14T13:30:00Z")), { year: 2026, month: 10 });
  assert.deepEqual(rc2(null, new Date("2026-10-14T12:59:00Z")), { year: 2026, month: 9 }); // 23:59 on the 14th Melbourne
});
test("cold cache plus a filtered listing that misses Oct: falls back to recent batches (any status, processing included)", async () => {
  const db = openDb({ path: join(mkdtempSync(join(tmpdir(), "pd-")), "t.db") });
  const E = B("B-e", "2026-08 Alpha (aaaaaaaa-0000-4000-8000-000000000001)", "2026-10-10T20:31:00Z", "processing");
  const M = B("B-m", "2026-10 Beta (aaaaaaaa-0000-4000-8000-000000000002)", "2026-10-10T20:31:00Z", "processing");
  const S = B("B-s", "2026-09 Beta (11111111-1111-1111-1111-111111111111)", "2026-09-07T20:31:00Z", "complete");
  const calls = [];
  const get = async (m, path, o = {}) => { calls.push(path + (o.query?.startDate ? "?startDate" : ""));
    if (path === "/batches") return o.query?.startDate ? { batches: [S], meta: { pages: 1 } } : { batches: [M, E, S], meta: { pages: 1 } };
    return { payments: [], meta: { pages: 1, records: 0 } }; };
  const r = await paydaySummary({}, { get, db, now: new Date("2026-10-14T13:30:00Z") });
  assert.equal(r.payday, "2026-10-15"); assert.equal(r.batches.Alpha.id, "B-e"); assert.equal(r.batches.Beta.id, "B-m");
  assert.equal(r.batches.Beta.status, "processing"); assert.ok(calls.includes("/batches"));
  assert.match(r.statusLine, /Australia\/Melbourne/);
  db.close();
});
test("config: TROLLEY_TIMEZONE / PAYDAY_DAY / BATCH_CREATE_DAY with fallback warnings", () => {
  assert.equal(paydayConfig({ TROLLEY_TIMEZONE: "Australia/Sydney" }).tz, "Australia/Sydney");
  const bad = paydayConfig({ TROLLEY_TIMEZONE: "Mars/Olympus", TROLLEY_PAYDAY_DAY: "32", TROLLEY_BATCH_CREATE_DAY: "x" });
  assert.deepEqual([bad.tz, bad.payday, bad.createDay, bad.warnings.length], ["Australia/Melbourne", 15, 11, 3]);
  const c = paydayConfig({ TROLLEY_PAYDAY_DAY: "1", TROLLEY_BATCH_CREATE_DAY: "26", TROLLEY_TIMEZONE: "UTC" });
  assert.deepEqual(rc2(null, new Date("2026-10-01T00:00:00Z"), c), { year: 2026, month: 10 });
  const w = cw2({ year: 2026, month: 1 }, c); // create day after payday: window starts in the previous month (Dec 23)
  assert.equal(w.start.toISOString(), "2025-12-23T00:00:00.000Z"); assert.equal(w.end.toISOString(), "2026-01-02T00:00:00.000Z"); assert.equal(w.payday, "2026-01-01");
  const d = cw2({ year: 2026, month: 10 }, paydayConfig({}));
  assert.equal(d.start.toISOString(), "2026-10-07T13:00:00.000Z"); // 8 Oct 00:00 AEDT
});
test("day 31 clamps to the month's last day", () => {
  const c = paydayConfig({ TROLLEY_PAYDAY_DAY: "31", TROLLEY_BATCH_CREATE_DAY: "31", TROLLEY_TIMEZONE: "UTC" });
  assert.equal(c.payday, 31); assert.equal(c.warnings.length, 0);
  assert.equal(cw2({ year: 2026, month: 4 }, c).payday, "2026-04-30");
  assert.equal(cw2({ year: 2027, month: 2 }, c).payday, "2027-02-28");
  assert.equal(cw2({ year: 2028, month: 2 }, c).payday, "2028-02-29");
  const w = cw2({ year: 2027, month: 2 }, c);
  assert.equal(w.start.toISOString(), "2027-02-25T00:00:00.000Z"); assert.equal(w.end.toISOString(), "2027-03-01T00:00:00.000Z");
  assert.equal(paydayConfig({ TROLLEY_PAYDAY_DAY: "0" }).payday, 15); assert.equal(paydayConfig({ TROLLEY_PAYDAY_DAY: "2.5" }).payday, 15);
});
test("most recent payday on or before today, with clamping across month boundaries", () => {
  const c = paydayConfig({ TROLLEY_PAYDAY_DAY: "31", TROLLEY_TIMEZONE: "UTC" });
  assert.deepEqual(rc2(null, new Date("2026-04-30T10:00:00Z"), c), { year: 2026, month: 4 }); // 30 Apr is April's payday
  assert.deepEqual(rc2(null, new Date("2026-04-29T10:00:00Z"), c), { year: 2026, month: 3 }); // before it: 31 Mar
  assert.deepEqual(rc2(null, new Date("2027-02-28T00:00:00Z"), c), { year: 2027, month: 2 });
  assert.deepEqual(rc2(null, new Date("2028-02-28T23:00:00Z"), c), { year: 2028, month: 1 }); // leap year: payday is the 29th
  assert.deepEqual(rc2(null, new Date("2028-03-01T00:00:00Z"), c), { year: 2028, month: 2 });
  assert.deepEqual(rc2("Feb", new Date("2027-02-27T00:00:00Z"), c), { year: 2026, month: 2 });
});
test("typical pattern: 8th 06:31 runs, mid-month follow-ups and ad-hoc batches are listed, not counted", async () => {
  const db = openDb({ path: join(mkdtempSync(join(tmpdir(), "pd-")), "t.db") });
  const u = "aaaaaaaa-0000-4000-8000-000000000001";
  const L = [B("E", `2026-07 Alpha (${u})`, "2026-09-07T20:31:00Z", "complete"), B("M", `2026-09 Beta (${u})`, "2026-09-07T20:31:00Z", "complete"),
    B("E2", `2026-07 Alpha (${u})`, "2026-09-17T01:31:00Z", "complete"), B("M2", `2026-09 Beta (${u})`, "2026-09-18T00:31:00Z", "complete"),
    B("A", "ACME BETA PAYOUT 24 SEP 2026", "2026-09-17T22:28:00Z", "complete"), B("X", "Payouts on 12 Sep 2026 #1", "2026-09-12T07:02:00Z", "complete"),
    B("NEXT", `2026-08 Alpha (${u})`, "2026-10-10T20:31:00Z", "processing")];
  const get = async (m, path) => path === "/batches" ? { batches: L, meta: { pages: 1 } } : { payments: [], meta: { pages: 1, records: 0 } };
  const r = await paydaySummary({ month: "Sep" }, { get, db, now: new Date("2026-10-15T02:00:00Z") });
  assert.equal(r.batches.Alpha.id, "E"); assert.equal(r.batches.Beta.id, "M");
  assert.deepEqual(r.otherBatchesThisMonth.map(b => b.id), ["X", "E2", "A", "M2"]); // NEXT (Oct) excluded
  assert.match(r.otherBatchesThisMonth.find(b => b.id === "E2").kind, /group-labelled/); assert.match(r.otherBatchesThisMonth.find(b => b.id === "A").kind, /ad-hoc/);
  assert.ok(r.notes.some(n => /Other batches this month: 4/.test(n)));
  db.close();
});
test("word match is case-insensitive and ignores the period prefix; falls back to unprefixed", () => {
  const w = cw2({ year: 2026, month: 10 }, paydayConfig({}));
  const k = classify([B("e", "2026-08 alpha (aaaaaaaa-0000-4000-8000-000000000001)", "2026-10-10T20:31:00Z"), B("m", "Acme BETA payout", "2026-10-10T20:31:00Z")], w);
  assert.deepEqual([k.Alpha[0].id, k.Beta[0].id], ["e", "m"]);
});
