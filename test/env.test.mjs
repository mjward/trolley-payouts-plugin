process.env.TROLLEY_CONFIG_FILE ??= "/nonexistent/trolley-test-config.json"; // isolate from the machine config
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectEnvironment, fingerprint } from "../server/env.mjs";
const SB = "FAKE_SANDBOX_KEY", PR = "FAKE_PROD_KEY";
const reg = `${fingerprint(SB)}=sandbox,${fingerprint(PR)}=production`;
test("fingerprint registry decides; key never echoed", () => {
  const d = detectEnvironment({ TROLLEY_ACCESS_KEY: SB, TROLLEY_KNOWN_KEYS: reg });
  assert.equal(d.environment, "sandbox"); assert.ok(!JSON.stringify(d).includes(SB));
  assert.equal(detectEnvironment({ TROLLEY_ACCESS_KEY: PR, TROLLEY_KNOWN_KEYS: reg }).environment, "production");
});
test("declared env used when unregistered; conflict detected (the leak case)", () => {
  assert.equal(detectEnvironment({ TROLLEY_ACCESS_KEY: SB, TROLLEY_ENVIRONMENT: "sandbox" }).environment, "sandbox");
  const c = detectEnvironment({ TROLLEY_ACCESS_KEY: PR, TROLLEY_ENVIRONMENT: "sandbox", TROLLEY_KNOWN_KEYS: reg });
  assert.equal(c.environment, "conflict"); assert.equal(c.conflict, true);
  assert.equal(detectEnvironment({ TROLLEY_ACCESS_KEY: SB }).environment, "unknown");
  assert.equal(detectEnvironment({ TROLLEY_ACCESS_KEY: PR, TROLLEY_ENVIRONMENT: "live" }).environment, "production");
});
