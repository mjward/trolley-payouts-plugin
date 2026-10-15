process.env.TROLLEY_BATCH_GROUPS = "Alpha,Beta";
import { test } from "node:test"; import assert from "node:assert/strict";
import { mkdtempSync, existsSync, statSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
process.env.TROLLEY_RATE_LIMIT = "2000"; process.env.TROLLEY_ACCESS_KEY = "TEST_KEY"; process.env.TROLLEY_SECRET_KEY = "TEST_SECRET";
const { loadConfig, writeConfig, parseBool, PRESETS } = await import("../server/config.mjs");
const { tools } = await import("../server/main.mjs");
const { DatabaseSync } = await import("node:sqlite");
const { dbPath } = await import("../server/db.mjs");

test("parseBool + precedence env > file > default(on)", () => {
  assert.equal(parseBool("TRUE"), true); assert.equal(parseBool("false"), false); assert.equal(parseBool(true), true);
  for (const x of ["yes", "1", "off", "maybe"]) assert.equal(parseBool(x), undefined); // only true/false
  const c = loadConfig({ TROLLEY_PAYMENT_CACHE: "false" }, { paymentCache: true, recipientCache: false, device: "laptop" });
  assert.deepEqual([c.recipientCache, c.paymentCache, c.syncEnabled], [false, false, true]);
  assert.deepEqual(c.source, { recipientCache: "file", paymentCache: "env", syncEnabled: "default" });
});
test("writeConfig: laptop = all on, phone = all off, mode 0600", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-")), env = { TROLLEY_CONFIG_FILE: join(dir, "c", "config.json") };
  for (const d of ["laptop", "phone"]) {
    const w = writeConfig(d, env); assert.equal(statSync(w.path).mode & 0o777, 0o600);
    const c = loadConfig(env); assert.deepEqual([c.recipientCache, c.paymentCache, c.syncEnabled], Object.values(PRESETS[d])); assert.equal(c.device, d);
  }
  assert.throws(() => writeConfig("tablet", env));
});

// Mock Trolley over fetch for the tool-level combination tests.
const u = "aaaaaaaa-0000-4000-8000-000000000001";
const B = { id: "B-e", description: `2026-08 Alpha (${u})`, createdAt: "2026-10-10T20:31:00Z", status: "complete", totalPayments: 1, updatedAt: "u", completedAt: "2020-01-01T00:00:00Z" };
const P = { id: "P-1", status: "processed", sourceAmount: "5.00", sourceCurrency: "USD", createdAt: "2026-10-10T20:31:00Z", recipient: { id: "R-1abc23", name: "Hidden Name" } };
const REC = { id: "R-1abc23", name: "Hidden Name", firstName: "Hidden", email: "r1@x.io", status: "active", updatedAt: "2026-10-15T00:00:00Z", isPhoneVerified: true };
let calls = [];
globalThis.fetch = async url => { const p = new URL(url).pathname.replace(/^\/v1/, ""); calls.push(p);
  const body = p === "/batches" ? { ok: true, batches: [B], meta: { pages: 1 } } : p.endsWith("/payments") ? { ok: true, payments: [P], meta: { pages: 1, records: 0 } }
    : p.startsWith("/recipients/") ? { ok: true, recipient: REC } : { ok: true, recipients: [REC], meta: { pages: 1, records: 1 } };
  return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(body) }; };

const combos = [];
for (const rc of [true, false]) for (const pc of [true, false]) for (const se of [true, false]) combos.push({ rc, pc, se });
for (const { rc, pc, se } of combos) test(`combo recipientCache=${rc} paymentCache=${pc} syncEnabled=${se}`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "combo-"));
  Object.assign(process.env, { TROLLEY_DB_PATH: join(dir, "t.db"), TROLLEY_CONFIG_FILE: join(dir, "none.json"),
    TROLLEY_RECIPIENT_CACHE: String(rc), TROLLEY_PAYMENT_CACHE: String(pc), TROLLEY_SYNC_ENABLED: String(se) });
  const file = dbPath();
  const count = t => { if (!existsSync(file)) return 0; const d = new DatabaseSync(file, { readOnly: true }); try { return d.prepare(`SELECT count(*) n FROM ${t}`).get().n; } finally { d.close(); } };

  calls = []; const s = await tools.sync_cache.run({ scope: "all" });
  if (!se) { assert.equal(s.status, "sync disabled"); assert.equal(calls.length, 0); }
  assert.equal(count("payments") > 0, se && pc, "payments cached only when sync+payment cache on");
  assert.equal(count("recipients") > 0, se && pc && rc, "lazy fill only with recipient cache (and cached payments)");

  const before = count("recipients");
  calls = []; const r = await tools.recipient_lookup.run({ query: "R-1abc23" });
  assert.equal(r.recipient.email, "r1@x.io"); assert.ok(!JSON.stringify(r).includes("Hidden")); assert.ok(calls.includes("/recipients/R-1abc23"), "lookups go live");
  if (!rc) assert.equal(count("recipients"), before, "recipient cache off: nothing written");
  else assert.ok(count("recipients") >= 1);

  const paymentsBefore = count("payments");
  const p = await tools.payday_summary.run({ month: "Oct 2026" });
  assert.equal(p.batches.Alpha.totalPayments, 1); assert.ok(!JSON.stringify(p).includes("Hidden"));
  if (!pc) { assert.equal(count("payments"), paymentsBefore); assert.match(p.source, /live/); }

  if (pc) assert.ok(Array.isArray((await tools.payout_query.run({ sql: "SELECT count(*) n FROM payments" })).rows ?? []));
  else await assert.rejects(tools.payout_query.run({ sql: "SELECT 1" }), /payment cache, which is disabled/);
  if (!pc && !rc) assert.equal(existsSync(file), false, "both caches off: no DB file at all");
});
test("init CLI: phone writes all-off config (0600) and never backfills", async () => {
  const { spawnSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "init-")), cfgFile = join(dir, "config.json");
  const env = { PATH: process.env.PATH, HOME: dir, TROLLEY_CONFIG_FILE: cfgFile, TROLLEY_DB_PATH: join(dir, "t.db"), TROLLEY_ACCESS_KEY: "K", TROLLEY_SECRET_KEY: "S" };
  const r = spawnSync(process.execPath, ["server/init.mjs", "--device", "phone", "--backfill"], { env, encoding: "utf8" });
  assert.equal(r.status, 0); assert.match(r.stdout, /skipped \(phone\)/); assert.equal(statSync(cfgFile).mode & 0o777, 0o600);
  assert.equal(existsSync(join(dir, "t-" )), false);
  const b = spawnSync(process.execPath, ["server/backfill.mjs"], { env, encoding: "utf8" }); // config says phone
  assert.equal(b.status, 0); assert.match(b.stdout, /"status":"phone"/);
  const none = spawnSync(process.execPath, ["server/init.mjs"], { env: { ...env, TROLLEY_CONFIG_FILE: join(dir, "x.json") }, encoding: "utf8" });
  assert.equal(none.status, 4); assert.match(none.stderr, /laptop or a phone/);
});
