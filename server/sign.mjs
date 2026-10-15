import { createHmac } from "node:crypto";
// Per docs: HMAC-SHA256(secret, timestamp\nMETHOD\nrequestPath\nbody\n), hex.
export function sign({ secret, timestamp, method, requestPath, body = "" }) {
  const message = `${timestamp}\n${method.toUpperCase()}\n${requestPath}\n${body}\n`;
  return createHmac("sha256", secret).update(message).digest("hex");
}
export function authHeaders({ accessKey, secret, method, requestPath, body = "", now = Date.now() }) {
  const timestamp = String(Math.floor(now / 1000));
  return {
    Authorization: `prsign ${accessKey}:${sign({ secret, timestamp, method, requestPath, body })}`,
    "X-PR-Timestamp": timestamp,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}
