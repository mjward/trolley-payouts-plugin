process.env.TROLLEY_CONFIG_FILE ??= "/nonexistent/trolley-test-config.json"; // isolate from the machine config
import { test } from "node:test";
import assert from "node:assert/strict";
import { tools } from "../server/main.mjs";
test("annotations: _read readOnly, _write destructive", () => {
  for (const t of Object.values(tools)) {
    if (t.name.endsWith("_read") || ["payout_stats","sync_cache","payout_query","recipient_lookup","payday_summary","whoami"].includes(t.name)) assert.equal(t.annotations.readOnlyHint, true, t.name);
    else { assert.equal(t.annotations.readOnlyHint, false); assert.equal(t.annotations.destructiveHint, true, t.name); }
  }
  assert.equal(Object.keys(tools).length, 28);
});
test("confirm-gated actions dry-run without any network call", async () => {
  process.env.TROLLEY_ACCESS_KEY = "AK_FAKE"; process.env.TROLLEY_SECRET_KEY = "SK_FAKE";
  const orig = globalThis.fetch; globalThis.fetch = () => { throw new Error("network called"); };
  try {
    const r = await tools.batches_write.run({ action: "start_processing", batchId: "B-abc123" });
    assert.equal(r.dryRun, true); assert.match(r.wouldCall, /start-processing/); assert.match(r.reason, /money/i);
    const d = await tools.recipients_write.run({ action: "delete", recipientId: "R-abc123" });
    assert.equal(d.dryRun, true);
  } finally { globalThis.fetch = orig; }
});
test("id prefixes are validated", async () => {
  await assert.rejects(tools.batches_read.run({ action: "get", batchId: "../x" }), /Invalid batchId/);
  await assert.rejects(tools.batches_read.run({ action: "nope" }), /Unknown action/);
});
