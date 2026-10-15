process.env.TROLLEY_BATCH_GROUPS = "Alpha,Beta";
process.env.TROLLEY_CONFIG_FILE = "/nonexistent/trolley-test-config.json";
import { test } from "node:test"; import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { effectivePayday, paydayToday, evaluate, runMonitor, failConfig, macNotify } from "../server/monitor.mjs";
import { plist } from "../server/schedule.mjs";
const cfg = { tz: "Australia/Melbourne", payday: 15, createDay: 11, warnings: [] };
const fc = { warn: 3, high: 10, minCount: 25, smallCount: 10, smallBatch: 300 };
const mel = (d, h) => new Date(Date.parse(`2026-10-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00+11:00`));
const B = (id, desc, status, extra = {}) => ({ id, description: desc, status, totalPayments: 1200, amount: "150000.00", currency: "USD", createdAt: "2026-10-10T01:00:00Z", updatedAt: "2026-10-14T23:00:00Z", ...extra });
const both = (se = "processing", sm = "processing", x = {}) => [B("B-E", "2026-08 Alpha payout", se, x), B("B-M", "2026-08 Beta payout", sm, x)];
const pd = (d, h) => paydayToday(mel(d, h), cfg);
const run = (batches, st, d, h, counts) => evaluate({ batches, state: st, now: mel(d, h), cfg, pd: pd(d, h), counts, fc });
const noPending = r => { for (const m of r.messages) assert.ok(!/pending/i.test(m.title + m.body), m.title + m.body); };

test("weekend shift: Sat 15th -> Mon 17th, Sun 15th -> Mon 16th, weekday unchanged, clamped", () => {
  assert.deepEqual([effectivePayday(2026, 8, cfg).day, effectivePayday(2026, 8, cfg).shifted], [17, true]);   // 15 Aug 2026 is a Saturday
  assert.equal(effectivePayday(2026, 11, cfg).day, 16);  // 15 Nov 2026 is a Sunday
  assert.deepEqual([effectivePayday(2026, 10, cfg).day, effectivePayday(2026, 10, cfg).shifted], [15, false]);
  const c31 = { ...cfg, payday: 31 }; const f = effectivePayday(2027, 2, c31); assert.equal(f.nominalDay, 28); assert.equal(f.day, 1); assert.equal(f.month, 3); // Sun 28 Feb 2027 -> Mon 1 Mar
  assert.ok(paydayToday(new Date("2027-03-01T03:00:00Z"), c31)); assert.equal(paydayToday(new Date("2026-08-15T03:00:00Z"), cfg), null); assert.ok(paydayToday(new Date("2026-08-17T03:00:00Z"), cfg));
});
test("out of payday: exits without any API call", async () => {
  let calls = 0; const r = await runMonitor({ get: async () => { calls++; return {}; }, now: mel(17, 10), cfg, enabled: true, state: "/nonexistent/x" });
  assert.equal(r.skipped, true); assert.match(r.reason, /outside payday window/); assert.equal(calls, 0);
  assert.equal((await runMonitor({ get: async () => { calls++; }, now: mel(15, 10), cfg, enabled: false })).skipped, true); assert.equal(calls, 0);
});
test("transitions notify once; unchanged status doesn't repeat; no 'pending' wording", () => {
  let r = run(both("awaiting_approval", "open"), undefined, 15, 8); assert.equal(r.messages.length, 2); assert.match(r.messages[0].title, /waiting for approval/); noPending(r);
  let r2 = run(both("awaiting_approval", "open"), r.state, 15, 8); assert.equal(r2.messages.length, 0);
  let r3 = run(both("processing", "awaiting_approval"), r2.state, 15, 9); assert.equal(r3.messages.length, 2); assert.ok(r3.messages.some(m => /approved \(processing\)/.test(m.body) && /moved from waiting for approval/.test(m.body)));
  assert.ok(r3.messages[0].body.includes("1200 payments") && r3.messages[0].body.includes("USD 150,000.00")); noPending(r3);
  const r4 = run(both("processing", "awaiting_approval"), r3.state, 15, 10); assert.equal(r4.messages.length, 0);
  const w = evaluate({ batches: [B("B-E", "Alpha pending x", "pending")], now: mel(15, 8), cfg, pd: pd(15, 8), fc }); noPending(w);
});
test("stuck alerts: approval at 12:00, processing at 17:00, each once", () => {
  let r = run(both("awaiting_approval", "processing"), undefined, 15, 11); assert.ok(!r.messages.some(m => /still/.test(m.title)));
  r = run(both("awaiting_approval", "processing"), r.state, 15, 12); assert.equal(r.messages.filter(m => /still waiting for approval/.test(m.title)).length, 2 - 1); noPending(r);
  r = run(both("awaiting_approval", "processing"), r.state, 15, 13); assert.equal(r.messages.length, 0);
  r = run(both("awaiting_approval", "processing"), r.state, 15, 17); assert.equal(r.messages.filter(m => /still processing/.test(m.title)).length, 1);
  r = run(both("awaiting_approval", "processing"), r.state, 15, 18); assert.equal(r.messages.length, 0);
});
test("missing Alpha/Beta batch alert at 09:00, once", () => {
  const only = [B("B-E", "2026-08 Alpha payout", "processing")];
  let r = run(only, undefined, 15, 8); assert.ok(!r.messages.some(m => /missing/.test(m.title)));
  r = run(only, r.state, 15, 9); assert.deepEqual(r.messages.map(m => m.title), ["Beta batch missing"]);
  r = run(only, r.state, 15, 10); assert.equal(r.messages.length, 0);
});
const fails = (counts, total, prev) => run([B("B-E", "2026-08 Alpha payout", "processing", { totalPayments: total }), B("B-M", "2026-08 Beta payout", "complete", { totalPayments: 1000 })], prev, 15, 10, counts).messages.filter(m => /failure/i.test(m.title));
test("failure rate: warn needs >3% AND >=25; escalates once over 10%; once only", () => {
  assert.equal(fails({ "B-E": { failed: 20, returned: 4 } }, 500).length, 0);          // 4.8% but 24 < 25
  assert.equal(fails({ "B-E": { failed: 10, returned: 5 } }, 1000).length, 0);         // 1.5%
  assert.equal(fails({ "B-E": { failed: 30, returned: 0 } }, 1000).length, 0);         // 3.0% not over
  const st0 = run(both(), undefined, 15, 9).state;
  let r = run([B("B-E", "2026-08 Alpha payout", "processing", { totalPayments: 1000 }), B("B-M", "2026-08 Beta payout", "complete")], st0, 15, 10, { "B-E": { failed: 30, returned: 5 } });
  const w = r.messages.filter(m => /failure/i.test(m.title)); assert.equal(w.length, 1); assert.match(w[0].body, /30 failed \+ 5 returned of 1000 payments \(3\.5%\)/);
  r = run([B("B-E", "2026-08 Alpha payout", "complete", { totalPayments: 1000 }), B("B-M", "2026-08 Beta payout", "complete")], r.state, 15, 11, { "B-E": { failed: 60, returned: 5 } });
  assert.equal(r.messages.filter(m => /failure/i.test(m.title)).length, 0); // still warn level, already sent
  r = run([B("B-E", "2026-08 Alpha payout", "complete", { totalPayments: 1000 }), B("B-M", "2026-08 Beta payout", "complete")], r.state, 15, 12, { "B-E": { failed: 101, returned: 5 } });
  assert.deepEqual(r.messages.filter(m => /failure/i.test(m.title)).map(m => m.title), ["High payment failure rate (over 10%)"]);
  r = run([B("B-E", "2026-08 Alpha payout", "complete", { totalPayments: 1000 }), B("B-M", "2026-08 Beta payout", "complete")], r.state, 15, 13, { "B-E": { failed: 200, returned: 5 } });
  assert.equal(r.messages.filter(m => /failure/i.test(m.title)).length, 0);
});
test("failure rate: small batches (<300) alert at >=10 failures regardless of rate", () => {
  assert.equal(fails({ "B-E": { failed: 6, returned: 3 } }, 299).length, 0);
  assert.deepEqual(fails({ "B-E": { failed: 6, returned: 4 } }, 299).map(m => m.title), ["Payment failures above threshold"]);
  assert.equal(fails({ "B-E": { failed: 30, returned: 0 } }, 100).length, 2); // 30% also escalates
});
test("failure counts fetched with 2 cheap calls per processing/complete batch; thresholds configurable", async () => {
  const calls = []; const get = async (m, path, { query }) => { calls.push([path, query]); if (path === "/batches") return { batches: both("processing", "awaiting_approval") }; return { payments: [], meta: { records: query.status === "failed" ? 40 : 2 } }; };
  const r = await runMonitor({ get, now: mel(15, 10), cfg, enabled: true, dryRun: true, state: join(mkdtempSync(join(tmpdir(), "m-")), "s.json"), fc });
  const pc = calls.filter(c => c[0] !== "/batches"); assert.equal(pc.length, 2); assert.ok(pc.every(c => c[1].pageSize === 1));
  assert.equal(r.tracked.find(t => t.kind === "Alpha").failed, 40);
  assert.deepEqual(failConfig({ TROLLEY_FAIL_RATE_WARN: "5", TROLLEY_FAIL_RATE_HIGH: "20", TROLLEY_FAIL_MIN_COUNT: "50", TROLLEY_FAIL_SMALL_BATCH_COUNT: "3" }), { warn: 5, high: 20, minCount: 50, smallCount: 3, smallBatch: 300 }); assert.equal(failConfig({ TROLLEY_FAIL_SMALL_BATCH_SIZE: "100" }).smallBatch, 100);
  assert.deepEqual(failConfig({}), fc);
});
test("notify uses argv (no AppleScript injection) and the monitor plist is a 15-min agent", () => {
  let got; macNotify('a"b', "c\" & do shell script \"x", (c, a) => { got = [c, a]; }); assert.equal(got[0], "/usr/bin/osascript"); assert.equal(got[1].at(-1), "c\" & do shell script \"x");
  const p = plist("monitor", { plugin: "/P", daemon: false }); assert.ok(!p.includes("UserName")); assert.equal((p.match(/<key>Minute<\/key>/g) || []).length, 4); assert.match(p, /<string>monitor<\/string><string>run<\/string>/);
});

test("48h window: starts 00:00 payday, ends 00:00 two days later; weekend shift moves it", () => {
  assert.equal(paydayToday(new Date("2026-10-14T12:59:59Z"), cfg), null);          // 23:59:59 on the 14th
  assert.equal(paydayToday(new Date("2026-10-14T13:00:00Z"), cfg).dayNum, 1);      // 00:00 on the 15th
  assert.equal(paydayToday(new Date("2026-10-16T12:59:59Z"), cfg).dayNum, 2);      // 23:59:59 on the 16th
  assert.equal(paydayToday(new Date("2026-10-16T13:00:00Z"), cfg), null);          // 00:00 on the 17th
  // Aug 2026: Sat 15th -> Mon 17th + Tue 18th (AEST +10)
  assert.equal(paydayToday(new Date("2026-08-15T03:00:00Z"), cfg), null); assert.equal(paydayToday(new Date("2026-08-16T03:00:00Z"), cfg), null);
  assert.equal(paydayToday(new Date("2026-08-17T03:00:00Z"), cfg).dayNum, 1); assert.equal(paydayToday(new Date("2026-08-18T03:00:00Z"), cfg).dayNum, 2);
  assert.equal(paydayToday(new Date("2026-08-19T03:00:00Z"), cfg), null);
  const c31 = { ...cfg, payday: 31 }; const p = paydayToday(new Date("2026-11-03T03:00:00Z"), c31); assert.equal(p.dayNum, 2); assert.deepEqual(p.cycle, { year: 2026, month: 10 }); assert.equal(paydayToday(new Date("2026-11-01T03:00:00Z"), c31), null); // Sat 31 Oct -> Mon 2 Nov + Tue 3 Nov
});
test("day 2: stuck and missing alerts repeat once with 'day 2'; transitions and failure alerts don't repeat", () => {
  let r = run(both("awaiting_approval", "processing"), undefined, 15, 17, { "B-M": { failed: 200, returned: 0 } });
  const d1 = r.messages.map(m => m.title);
  assert.ok(d1.includes("Batch still waiting for approval") && d1.includes("Batch still processing") && d1.some(t => /failure/i.test(t)));
  r = run(both("awaiting_approval", "processing"), r.state, 16, 8, { "B-M": { failed: 200, returned: 0 } }); assert.equal(r.messages.length, 0);
  r = run(both("awaiting_approval", "processing"), r.state, 16, 12, { "B-M": { failed: 200, returned: 0 } });
  assert.deepEqual(r.messages.map(m => m.title), ["Batch still waiting for approval (day 2)"]); assert.match(r.messages[0].body, /day 2 of payday/);
  r = run(both("awaiting_approval", "processing"), r.state, 16, 13, { "B-M": { failed: 200, returned: 0 } }); assert.equal(r.messages.length, 0);
  r = run(both("awaiting_approval", "processing"), r.state, 16, 17, { "B-M": { failed: 200, returned: 0 } }); assert.deepEqual(r.messages.map(m => m.title), ["Batch still processing (day 2)"]);
  const only = [B("B-E", "2026-08 Alpha payout", "complete")];
  let m = run(only, undefined, 15, 9); m = run(only, m.state, 16, 8); assert.equal(m.messages.length, 0);
  m = run(only, m.state, 16, 9); assert.deepEqual(m.messages.map(x => x.title), ["Beta batch missing (day 2)"]);
  m = run(only, m.state, 16, 10); assert.equal(m.messages.length, 0);
});
test("no names: only /batches endpoints, never includeSensitive or /recipients, no recipient fields in output", async () => {
  const calls = []; const get = async (mm, path, opt = {}) => { calls.push([path, opt]); if (path === "/batches") return { batches: both().map(b => ({ ...b, recipient: { name: "Jane Secretname" } })) }; return { payments: [{ recipient: { name: "Jane Secretname" } }], meta: { records: 1 } }; };
  const r = await runMonitor({ get, now: mel(15, 10), cfg, enabled: true, dryRun: true, state: join(mkdtempSync(join(tmpdir(), "m-")), "s.json"), fc });
  assert.ok(!JSON.stringify(r).includes("Secretname")); assert.ok(calls.every(([p, o]) => p.startsWith("/batches") && !JSON.stringify(o).includes("includeSensitive")));
});
