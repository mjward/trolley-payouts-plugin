// Zero-dependency Trolley MCP server (newline-delimited JSON-RPC 2.0 over stdio).
import { createInterface } from "node:readline";
import { RESOURCES, ID_ARGS } from "./routes.mjs";
import { request, ToolError } from "./client.mjs";
import { shape } from "./shape.mjs";
import { payoutStatsTool } from "./stats.mjs";
import { syncCacheTool } from "./sync.mjs";
import { payoutQueryTool } from "./query.mjs";
import { recipientLookupTool } from "./lookup.mjs";
import { paydaySummaryTool } from "./payday.mjs";
import { whoamiTool, assertNoConflict, detectEnvironment } from "./env.mjs";

const VERSION = "0.7.0";
const MAX_PAGES_DEFAULT = 20;

function fillPath(tpl, args) {
  return tpl.replace(/\{(\w+)\}/g, (_, name) => {
    const v = args[name];
    if (!v) throw new ToolError(`Missing required argument: ${name}`);
    const prefix = ID_ARGS[name];
    if (prefix && !new RegExp(`^${prefix}-[A-Za-z0-9]+$`).test(v)) throw new ToolError(`Invalid ${name}: expected ${prefix}-… id`);
    if (!prefix && !/^[A-Za-z0-9_-]+$/.test(v)) throw new ToolError(`Invalid ${name}`);
    return encodeURIComponent(v);
  });
}

async function runList(route, path, a, resource) {
  const pageSize = a.pageSize ?? (a.all ? 100 : undefined);
  const maxPages = a.maxPages ?? MAX_PAGES_DEFAULT;
  const call = page => route.bodyPaging
    ? request(route.m, path, { body: { ...(a.body || {}), ...(page ? { page } : {}), ...(pageSize ? { pageSize } : {}) } })
    : request(route.m, path, { query: { ...(a.query || {}), page, pageSize } });
  if (!a.all) return shape(resource, await call(a.page), a);
  let page = a.page ?? 1, items = [], meta = null, pagesFetched = 0;
  for (;;) {
    const json = await call(page); pagesFetched++;
    items.push(...(json[route.list] || [])); meta = json.meta || null;
    if (!meta || page >= (meta.pages ?? page) || pagesFetched >= maxPages) break;
    page++;
  }
  const out = shape(resource, { ok: true, [route.list]: items }, a);
  return { ...out, meta: { ...meta, pagesFetched, truncated: !!meta && page < (meta.pages ?? page) } };
}

async function needsConfirm(route, a) {
  if (route.confirm === true) return true;
  if (route.confirm === "batchNotOpen") {
    const b = await request("GET", `/batches/${fillPath("{batchId}", a)}`);
    return b.batch?.status !== "open" ? `batch status is '${b.batch?.status}' (not 'open')` : false;
  }
  return false;
}

function makeTool(resource, kind, def) {
  const actions = def[kind];
  const idProps = {};
  for (const r of Object.values(actions)) for (const [, n] of r.p.matchAll(/\{(\w+)\}/g)) idProps[n] = { type: "string" };
  const anyList = Object.values(actions).some(r => r.list);
  const props = {
    action: { type: "string", enum: Object.keys(actions) },
    ...idProps,
    query: { type: "object", description: "Query-string filters per Trolley docs (e.g. search, status, tags, orderBy, sortBy)." },
    body: { type: "object", description: "JSON request body per Trolley docs." },
    ...(anyList ? { page: { type: "integer", minimum: 1 }, pageSize: { type: "integer", minimum: 1, maximum: 1000 },
      all: { type: "boolean", description: "Auto-paginate list actions and merge results." }, maxPages: { type: "integer", minimum: 1, description: `Cap for all:true (default ${MAX_PAGES_DEFAULT}).` } } : {}),
    raw: { type: "boolean", description: "Return Trolley's objects instead of normalized summaries (sensitive fields are always stripped)." },
    ...(kind === "write" ? { confirm: { type: "boolean", description: "Required true for irreversible or money-moving actions; otherwise a dry-run description is returned." } } : {}),
  };
  const lines = Object.entries(actions).map(([n, r]) => `${n}: ${r.m} /v1${r.p}${r.confirm ? (r.money ? " [MONEY-MOVING, needs confirm]" : r.confirm === true ? " [needs confirm]" : " [needs confirm if batch not open]") : ""}`);
  return {
    name: `${resource}_${kind}`,
    description: `${def.doc} ${kind === "read" ? "Read-only." : "WRITES to Trolley."}\nActions:\n${lines.join("\n")}`,
    inputSchema: { type: "object", properties: props, required: ["action"] },
    annotations: kind === "read"
      ? { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
      : { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    async run(a) {
      const route = actions[a.action];
      if (!route) throw new ToolError(`Unknown action '${a.action}'. Valid: ${Object.keys(actions).join(", ")}`);
      const path = fillPath(route.p, a);
      if (kind === "write") {
        const why = await needsConfirm(route, a);
        if (why && a.confirm !== true) return { dryRun: true, wouldCall: `${route.m} /v1${path}`, body: a.body ?? null,
          reason: typeof why === "string" ? why : route.money ? "This moves real money and cannot be undone." : "This action is irreversible.",
          next: "Re-run with confirm:true only after the user explicitly approves." };
      }
      if (route.list) return runList(route, path, a, resource);
      const json = await request(route.m, path, { query: a.query, body: route.m === "GET" ? undefined : a.body });
      return shape(resource, json, a);
    },
  };
}

export const tools = {};
for (const [res, def] of Object.entries(RESOURCES)) for (const kind of ["read", "write"]) if (def[kind]) { const t = makeTool(res, kind, def); tools[t.name] = t; }
for (const t of [syncCacheTool, payoutStatsTool, payoutQueryTool, recipientLookupTool, paydaySummaryTool, whoamiTool]) tools[t.name] = t;

export const POLICY_ERROR = "includeSensitive is disabled by policy: this plugin never returns sensitive recipient data (SSN/government IDs, DOB, passport, address, bank account/IBAN/routing/SWIFT numbers, tax fields, phone, webhook secrets). Remove the argument; use the Trolley dashboard if you truly need these.";
export const checkPolicy = args => (args && Object.prototype.hasOwnProperty.call(args, "includeSensitive") ? POLICY_ERROR : null);
for (const t of Object.values(tools)) {
  const run = t.run;
  t.run = async a => {
    const e = checkPolicy(a); if (e) throw new ToolError(e);
    if (t.name !== "whoami") assertNoConflict();
    const out = await run(a);
    // Every result says which environment it came from.
    return out && typeof out === "object" && !Array.isArray(out) && t.name !== "whoami" ? { environment: detectEnvironment().environment, ...out } : out;
  };
}

const send = m => process.stdout.write(JSON.stringify(m) + "\n");
async function handle(msg) {
  const { id, method, params = {} } = msg;
  const reply = result => id !== undefined && send({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => id !== undefined && send({ jsonrpc: "2.0", id, error: { code, message } });
  switch (method) {
    case "initialize": return reply({ protocolVersion: params.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "trolley", version: VERSION } });
    case "notifications/initialized": case "notifications/cancelled": return;
    case "ping": return reply({});
    case "tools/list": return reply({ tools: Object.values(tools).map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })) });
    case "tools/call": {
      const t = tools[params.name];
      if (!t) return fail(-32602, `Unknown tool: ${params.name}`);
      const policyErr = checkPolicy(params.arguments);
      if (policyErr) return reply({ isError: true, content: [{ type: "text", text: policyErr }] });
      try { return reply({ content: [{ type: "text", text: JSON.stringify(await t.run(params.arguments || {}), null, 2) }] }); }
      catch (e) { return reply({ isError: true, content: [{ type: "text", text: e instanceof ToolError ? e.message : `Error: ${e.message}` }] }); }
    }
    default: return fail(-32601, `Method not found: ${method}`);
  }
}
export function startStdio() {
  createInterface({ input: process.stdin }).on("line", line => {
    if (!line.trim()) return;
    let msg; try { msg = JSON.parse(line); } catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
    handle(msg).catch(e => send({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32603, message: e.message } }));
  });
}
