// Status display: emoji dot + inline code, e.g. "🟡 `incomplete`". Raw status is kept separately in JSON.
const GREEN = new Set(["active", "processed", "completed", "complete"]);
const YELLOW = new Set(["incomplete", "pending", "open", "awaiting approval"]);
const RED = new Set(["blocked", "failed", "returned", "suspended"]);
export function badgeDot(status) {
  const s = String(status ?? "").trim().toLowerCase().replace(/[_-]+/g, " ");
  return GREEN.has(s) ? "🟢" : YELLOW.has(s) ? "🟡" : RED.has(s) ? "🔴" : "⚪";
}
export function badge(status) {
  if (status == null || status === "") return null;
  return `${badgeDot(status)} \`${String(status).replace(/`/g, "")}\``;
}
