process.env.TROLLEY_CONFIG_FILE ??= "/nonexistent/trolley-test-config.json"; // isolate from the machine config
import { test } from "node:test"; import assert from "node:assert/strict";
import { envRateLimit } from "../server/limiter.mjs";
test("TROLLEY_RATE_LIMIT wins over the _PER_MIN alias; default 100", () => {
  assert.equal(envRateLimit({}), 100);
  assert.equal(envRateLimit({ TROLLEY_RATE_LIMIT_PER_MIN: "900" }), 900);
  assert.equal(envRateLimit({ TROLLEY_RATE_LIMIT: "50", TROLLEY_RATE_LIMIT_PER_MIN: "900" }), 50);
  assert.equal(envRateLimit({ TROLLEY_RATE_LIMIT: "junk", TROLLEY_RATE_LIMIT_PER_MIN: "60" }), 60);
});
