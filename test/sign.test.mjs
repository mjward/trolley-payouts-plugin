process.env.TROLLEY_CONFIG_FILE ??= "/nonexistent/trolley-test-config.json"; // isolate from the machine config
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { sign, authHeaders } from "../server/sign.mjs";

// Fake fixture values, not real keys.
const fx = { secret: "test-secret-NOT-REAL", timestamp: "1656393402", method: "get", requestPath: "/v1/recipients?search=bob&page=2", body: "" };

function openssl(msg, key) {
  return execFileSync("openssl", ["dgst", "-sha256", "-hmac", key, "-r"], { input: msg }).toString().split(" ")[0].trim();
}
test("signature matches independent openssl HMAC (GET, empty body)", () => {
  const expected = openssl(`${fx.timestamp}\nGET\n${fx.requestPath}\n\n`, fx.secret);
  assert.equal(sign(fx), expected);
});
test("signature matches openssl with JSON body string", () => {
  const body = '{"type":"individual","email":"a@example.com"}';
  const expected = openssl(`${fx.timestamp}\nPOST\n/v1/recipients\n${body}\n`, fx.secret);
  assert.equal(sign({ ...fx, method: "POST", requestPath: "/v1/recipients", body }), expected);
});
test("authHeaders format", () => {
  const h = authHeaders({ accessKey: "AK_FAKE", secret: fx.secret, method: "GET", requestPath: fx.requestPath, now: 1656393402000 });
  assert.equal(h["X-PR-Timestamp"], "1656393402");
  assert.match(h.Authorization, /^prsign AK_FAKE:[0-9a-f]{64}$/);
  assert.equal(h.Authorization.split(":")[1], sign(fx));
});
