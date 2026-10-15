process.env.TROLLEY_CONFIG_FILE = "/nonexistent/trolley-test-config.json";
import { test } from "node:test"; import assert from "node:assert/strict";
import { batchGroups, groupOf, classify, inAnyGroup } from "../server/payday.mjs";
import { evaluate, paydayToday } from "../server/monitor.mjs";
const win = { start: new Date("2026-01-08T00:00:00Z"), end: new Date("2026-01-16T00:00:00Z") };
const B = (id, description, createdAt = "2026-01-11T00:00:00Z", status = "processing") => ({ id, description, createdAt, status, totalPayments: 100, amount: "1000.00", currency: "USD" });
test("TROLLEY_BATCH_GROUPS parses a comma list; multi-word groups match whole words, case-insensitive", () => {
  assert.deepEqual(batchGroups({ TROLLEY_BATCH_GROUPS: " Group A, Group B ,," }), ["Group A", "Group B"]);
  assert.deepEqual(batchGroups({}), []);
  const g = ["Group A", "Group B"];
  assert.equal(groupOf("2026-01 group a (x)", g), "Group A"); assert.equal(groupOf("ACME GROUP B PAYOUT", g), "Group B");
  assert.equal(groupOf("Group AB run", g), null); assert.equal(inAnyGroup("anything", []), true); assert.equal(inAnyGroup("anything", g), false);
});
test("classify: groups pick per-group batches (missing group is empty); no groups lists every batch in the window", () => {
  const bs = [B("B1", "2026-01 Group A payout"), B("B2", "Group B payout run"), B("B3", "Ad-hoc refund"), B("B4", "Group A late", "2026-01-20T00:00:00Z")];
  const k = classify(bs, win, ["Group A", "Group B", "Group C"]);
  assert.deepEqual(Object.fromEntries(Object.entries(k).map(([n, a]) => [n, a.map(b => b.id)])), { "Group A": ["B1"], "Group B": ["B2"], "Group C": [] });
  const all = classify(bs, win, []); assert.deepEqual(Object.values(all).map(a => a[0].id), ["B1", "B2", "B3"]);
});
test("monitor without groups: tracks every batch, never sends missing-group warnings", () => {
  const cfg = { tz: "Australia/Melbourne", payday: 15, createDay: 11, warnings: [] };
  const now = new Date("2026-01-15T00:00:00Z"); // 11:00 Melbourne on payday
  const r = evaluate({ groups: [], batches: [B("B1", "Payout run one"), B("B2", "Payout run two")], now, cfg, pd: paydayToday(now, cfg), fc: { warn: 3, high: 10, minCount: 25, smallCount: 10, smallBatch: 300 } });
  assert.equal(r.tracked.length, 2); assert.ok(!r.messages.some(m => /missing/.test(m.title)));
});
