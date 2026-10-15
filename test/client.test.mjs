process.env.TROLLEY_CONFIG_FILE ??= "/nonexistent/trolley-test-config.json"; // isolate from the machine config
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildQuery, retryDelayMs, request } from "../server/client.mjs";
import { redact, shape } from "../server/shape.mjs";
import { sign } from "../server/sign.mjs";

test("buildQuery skips empties and joins arrays", () => {
  assert.equal(buildQuery({ page: 2, search: "", tags: ["a", "b"], x: undefined }), "?page=2&tags=a%2Cb");
  assert.equal(buildQuery({}), "");
});
test("retryDelayMs honours Retry-After seconds, date, and backs off otherwise", () => {
  assert.equal(retryDelayMs("2", 0), 2000);
  assert.equal(retryDelayMs("999", 0), 60000);
  assert.ok(retryDelayMs(new Date(Date.now() + 3000).toUTCString(), 0) <= 3000);
  assert.equal(retryDelayMs(null, 2), 4000);
});
test("request retries 429 then succeeds, re-signing exact path and body", async () => {
  process.env.TROLLEY_ACCESS_KEY = "AK_FAKE"; process.env.TROLLEY_SECRET_KEY = "SK_FAKE_NOT_REAL";
  const seen = []; let n = 0;
  const fetchImpl = async (url, init) => {
    seen.push({ url, init }); n++;
    if (n === 1) return new Response(JSON.stringify({ ok: false, errors: [{ code: "rate_limit_exceeded", message: "x" }] }), { status: 429, headers: { "retry-after": "0" } });
    return new Response(JSON.stringify({ ok: true, batch: { id: "B-1" } }), { status: 200 });
  };
  const out = await request("POST", "/batches", { query: { a: 1 }, body: { description: "t" }, fetchImpl });
  assert.equal(out.batch.id, "B-1"); assert.equal(seen.length, 2);
  const { headers, body } = seen[1].init;
  assert.equal(seen[1].url, "https://api.trolley.com/v1/batches?a=1");
  assert.equal(body, '{"description":"t"}');
  assert.equal(headers.Authorization.split(":")[1], sign({ secret: "SK_FAKE_NOT_REAL", timestamp: headers["X-PR-Timestamp"], method: "POST", requestPath: "/v1/batches?a=1", body }));
});
test("request surfaces Trolley errors[]", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ ok: false, errors: [{ code: "invalid_field", field: "email", message: "bad" }] }), { status: 400 });
  await assert.rejects(request("GET", "/recipients", { fetchImpl }), /HTTP 400: invalid_field \(email\): bad/);
});
test("missing env vars give a clear error", async () => {
  const a = process.env.TROLLEY_ACCESS_KEY; delete process.env.TROLLEY_ACCESS_KEY;
  await assert.rejects(request("GET", "/balances"), /Missing required env var\(s\): TROLLEY_ACCESS_KEY/);
  process.env.TROLLEY_ACCESS_KEY = a;
});
test("redaction and recipient trimming", () => {
  const r = { id: "R-1", firstName: "A", lastName: "B", ssn: "x", dob: "y", governmentIds: [], address: { country: "CA", street1: "s" }, accounts: [{ accountNum: "1" }], taxForm: {} };
  const s = shape("recipients", { ok: true, recipient: r });
  assert.deepEqual(Object.keys(s.recipient).sort(), ["complianceStatus","country","createdAt","email","id","payoutMethod","referenceId","status"].sort());
  assert.equal(s.recipient.country, "CA");
  const red = JSON.stringify(redact({ nested: { recipient: r, hmac: "h" } }));
  for (const k of ["ssn", "dob", "governmentIds", "address", "accounts", "hmac", "taxForm", "firstName", "lastName", "name"]) assert.ok(!red.includes(`"${k}"`), k);
});
test("body-read timeout is retried for GET, not thrown uncaught", async () => {
  process.env.TROLLEY_ACCESS_KEY ||= "k"; process.env.TROLLEY_SECRET_KEY ||= "s";
  let n = 0;
  const fetchImpl = async () => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => { if (++n === 1) throw new DOMException("aborted", "TimeoutError"); return '{"ok":true,"x":1}'; } });
  const { request } = await import("../server/client.mjs");
  const r = await request("GET", "/x", { fetchImpl, limiter: null }); assert.equal(r.x, 1); assert.equal(n, 2);
});
