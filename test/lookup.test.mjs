process.env.TROLLEY_BATCH_GROUPS = "Alpha,Beta";
process.env.TROLLEY_CONFIG_FILE ??= "/nonexistent/trolley-test-config.json"; // isolate from the machine config
import { test } from "node:test";
import assert from "node:assert/strict";
import { recipientLookup, normalizeInput, routeFor } from "../server/lookup.mjs";

const R = (id, email, extra = {}) => ({ id, email, name: "N", status: "active", referenceId: "ref", complianceStatus: "verified", payoutMethod: "paypal",
  createdAt: "2026-01-01T00:00:00Z", isPhoneVerified: true, ssn: "1", dob: "d", phone: "+1", address: { country: "CA", street1: "s" }, accounts: [{ accountNum: "1" }], ...extra });
// Mock of Trolley: email filter exact (case-sensitive), referenceId exact, search = case-insensitive prefix on name / email user / email domain / referenceId.
function mock(all) {
  const calls = [];
  const get = async (m, path, { query = {} } = {}) => {
    calls.push(path + (Object.keys(query).filter(k => !["page", "pageSize"].includes(k)).map(k => `?${k}=${query[k]}`).join("")));
    if (path === "/recipients") {
      let hits = all;
      if (query.email != null) hits = all.filter(r => r.email === query.email);
      else if (query.referenceId != null) hits = all.filter(r => r.referenceId === query.referenceId);
      else if (query.search != null) { const q = query.search.toLowerCase(); hits = all.filter(r => [r.name, ...(r.email || "").split("@"), r.referenceId].some(f => String(f || "").toLowerCase().startsWith(q))); }
      return { recipients: hits.slice(0, query.pageSize), meta: { records: hits.length } };
    }
    const r = all.find(x => x.id === decodeURIComponent(path.split("/").pop()));
    if (r) return { recipient: r };
    throw new Error("Trolley HTTP 404: not_found: Object not found");
  };
  return { get, calls };
}
const U = "bbbbbbbb-0000-4000-8000-000000000001";
const DB = [R("R-aaa111", "Jane@X.io", { referenceId: U, name: "Jane Doe" }), R("R-bbb222", "fred@y.io", { name: "Jane Example", referenceId: "x1" }),
  ...Array.from({ length: 12 }, (_, i) => R(`R-env${i}`, `p${i}@example.com`, { name: `P ${i}`, referenceId: `e${i}` }))];

test("normalizes pasted input and routes", () => {
  assert.equal(normalizeInput("  <mailto:A@b.io> "), "A@b.io"); assert.equal(normalizeInput('"R-abc123"'), "R-abc123");
  assert.equal(routeFor(U.toUpperCase()), "referenceId"); assert.equal(routeFor("a@b.io"), "email"); assert.equal(routeFor("R-Example123"), "id"); assert.equal(routeFor("Jane Example"), "search");
});
test("R- id: GET /recipients/:id, trimmed; not found is clear and doesn't search", async () => {
  const { get, calls } = mock(DB);
  const r = await recipientLookup({ query: "R-aaa111" }, { get });
  assert.equal(r.matchedBy, "id"); for (const k of ["ssn", "dob", "phone", "address", "accounts"]) assert.ok(!(k in r.recipient));
  await assert.rejects(recipientLookup({ query: "R-zzz999" }, { get }), /No recipient found with ID R-zzz999/);
  assert.deepEqual(calls, ["/recipients/R-aaa111", "/recipients/R-zzz999"]);
});
test("UUID: referenceId= exact; partial UUID-shaped miss is not-found without search", async () => {
  const { get, calls } = mock(DB);
  const r = await recipientLookup({ query: U }, { get }); assert.equal(r.matchedBy, "referenceId"); assert.equal(r.recipient.id, "R-aaa111");
  await assert.rejects(recipientLookup({ query: "bbbbbbbb-0000-4000-8000-000000000000" }, { get }), /No recipient found with referenceId/);
  assert.ok(calls.every(c => !c.includes("search")));
});
test("email: exact, case-insensitive; miss is not-found without search", async () => {
  const { get, calls } = mock(DB);
  assert.equal((await recipientLookup({ query: "Jane@X.io" }, { get })).recipient.id, "R-aaa111");
  await assert.rejects(recipientLookup({ query: "alex@example.com" }, { get }), /No recipient found with email/);
  assert.ok(calls.every(c => !c.includes("search")));
  const dup = mock([R("R-1", "a@x.io"), R("R-2", "a@x.io")]);
  await assert.rejects(recipientLookup({ query: "a@x.io" }, { get: dup.get }), /Ambiguous: 2/);
});
test("search: one hit returns it; many return <=10 trimmed candidates + count; none is not-found", async () => {
  const { get } = mock(DB);
  const one = await recipientLookup({ query: "Jane Example" }, { get }); assert.equal(one.matchedBy, "search"); assert.equal(one.recipient.id, "R-bbb222");
  const many = await recipientLookup({ query: "example.com" }, { get });
  assert.equal(many.matchedBy, "search"); assert.equal(many.count, 12); assert.equal(many.candidates.length, 10); assert.ok(!("ssn" in many.candidates[0]));
  await assert.rejects(recipientLookup({ query: "nobody" }, { get }), /No recipient matches search/);
});
test("cache fallback: live failure on R- id serves the cached non-PII row; successes are written to the cache", async () => {
  const put = []; const cache = { get: id => (id === "R-aaa111" ? { id, name: "Jane Doe", email: "Jane@X.io", status: "active", complianceStatus: "verified", country: "CA", isPhoneVerified: true, ssn: "LEAK" } : null), put: r => put.push(r.id) };
  await recipientLookup({ query: "R-aaa111" }, { get: mock(DB).get, cache }); assert.deepEqual(put, ["R-aaa111"]);
  const down = async () => { throw new Error("Network error calling Trolley"); };
  const r = await recipientLookup({ query: "R-aaa111" }, { get: down, cache });
  assert.equal(r.source, "cache"); assert.ok(!("name" in r.recipient)); assert.equal(r.recipient.email, "Jane@X.io"); assert.ok(!("ssn" in r.recipient)); assert.equal(r.recipient.isPhoneVerified, true);
});
test("rule: /recipient returns email but never a name (single, candidates, search-by-name); no includeSensitive", async () => {
  const { get } = mock(DB);
  const r = await recipientLookup({ query: "R-aaa111" }, { get });
  assert.equal(r.recipient.email, "Jane@X.io"); assert.ok(!JSON.stringify(r).includes("Jane Doe")); assert.ok(!("name" in r.recipient));
  const byName = await recipientLookup({ query: "Jane Example" }, { get }); assert.equal(byName.recipient.id, "R-bbb222"); assert.ok(!JSON.stringify(byName).includes("Jane"));
  const many = await recipientLookup({ query: "example.com" }, { get }); assert.ok(many.candidates.every(c => !("name" in c))); assert.ok(!/"P \d+"/.test(JSON.stringify(many)));
  const { recipientLookupTool } = await import("../server/lookup.mjs");
  assert.ok(!JSON.stringify(recipientLookupTool.inputSchema).includes("includeSensitive"));
});
