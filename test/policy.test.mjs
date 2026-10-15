process.env.TROLLEY_CONFIG_FILE ??= "/nonexistent/trolley-test-config.json"; // isolate from the machine config
import { test } from "node:test";
import assert from "node:assert/strict";
import { tools, POLICY_ERROR } from "../server/main.mjs";
import { shape } from "../server/shape.mjs";

const SENS = ["ssn", "governmentIds", "governmentId", "dob", "passport", "address", "street1", "street2", "postalCode", "accountNum", "iban",
  "routingNumber", "swiftBic", "taxForm", "taxFormStatus", "taxWithholdingPercentage", "phone", "hmac", "accounts", "placeOfBirth", "citizenships"];
const recipient = { id: "R-1", name: "N", email: "e@x.y", status: "active", ssn: "1", governmentIds: [{ value: "x" }], dob: "d", passport: "p",
  address: { street1: "s", postalCode: "z", country: "CA" }, phone: "1", accounts: [{ accountNum: "1", iban: "i", routingNumber: "r", swiftBic: "s" }],
  taxForm: {}, taxFormStatus: "x", taxWithholdingPercentage: "0", placeOfBirth: "x", citizenships: [], nested: { street2: "x", bankAccountNumber: "9", phoneNumber: "1" } };

test("no tool schema exposes includeSensitive", () => {
  for (const t of Object.values(tools)) assert.ok(!JSON.stringify(t.inputSchema).includes("includeSensitive"), t.name);
});
test("passing includeSensitive is rejected by every tool", async () => {
  for (const t of Object.values(tools)) await assert.rejects(t.run({ action: "list", includeSensitive: true }), e => e.message === POLICY_ERROR, t.name);
  await assert.rejects(tools.recipients_read.run({ action: "get", recipientId: "R-1", includeSensitive: false }), /disabled by policy/);
});
test("raw:true output stays stripped (recursively, incl. pattern variants)", () => {
  for (const out of [shape("recipients", { ok: true, recipient }, { raw: true }), shape("recipients", { ok: true, recipients: [recipient] }, { raw: true }),
    shape("payments", { ok: true, payment: { id: "P-1", recipient } }, { raw: true }), shape("webhooks", { ok: true, subscription: { id: "SS-1", hmac: "h" } }, { raw: true })]) {
    const j = JSON.stringify(out);
    for (const k of [...SENS, "bankAccountNumber", "phoneNumber"]) assert.ok(!j.includes(`"${k}"`), k);
  }
  assert.equal(shape("recipients", { ok: true, recipient }, { raw: true }).recipient.email, "e@x.y");
});
test("allowlist: isPhoneVerified (boolean) survives; phone numbers stay stripped", async () => {
  const { redact } = await import("../server/shape.mjs");
  const out = redact({ isPhoneVerified: true, phone: "1", phoneNumber: "2", mobile: "3", mobilePhone: "4", nested: { isPhoneVerified: false, phone: "5" } });
  assert.deepEqual(out, { isPhoneVerified: true, nested: { isPhoneVerified: false } });
  assert.deepEqual(redact({ isPhoneVerified: "+15551234" }), {}); // non-boolean value is not allowed through
});
