process.env.TROLLEY_CONFIG_FILE ??= "/nonexistent/trolley-test-config.json"; // isolate from the machine config
import { test } from "node:test"; import assert from "node:assert/strict";
import { badge, badgeDot } from "../server/badge.mjs";
test("emoji dot + inline code", () => {
  assert.equal(badge("incomplete"), "🟡 `incomplete`");
  assert.equal(badge("awaiting_approval"), "🟡 `awaiting_approval`");
  for (const s of ["active","processed","completed"]) assert.equal(badgeDot(s), "🟢");
  for (const s of ["blocked","failed","returned","suspended"]) assert.equal(badgeDot(s), "🔴");
  assert.equal(badgeDot("open"), "🟡"); assert.equal(badgeDot("processing"), "⚪"); assert.equal(badge(null), null);
});
