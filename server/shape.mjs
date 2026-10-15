// Normalizers + PII redaction. Policy: sensitive fields are ALWAYS stripped (no opt-out; raw:true included).
export const SENSITIVE_KEYS = new Set(["name", "firstName", "lastName", "ssn", "governmentId", "governmentIds", "dob", "passport", "placeOfBirth", "birthplace", "citizenships",
  "address", "accounts", "account", "accountNum", "accountNumber", "iban", "routingNumber", "bankId", "branchId", "swiftBic", "bankAddress",
  "taxForm", "taxFormStatus", "taxDeliveryType", "taxWithholdingPercentage", "taxes", "tin", "phone", "hmac", "occupation", "riskScore", "riskScoreLabel", "brn"]);
// Pattern backstop for variants (e.g. street1, postalCode, bankAccountNumber, swiftCode, taxId, phoneNumber, webhookSecret).
export const SENSITIVE_PATTERN = /ssn|social.?security|government.?id|passport|^dob$|date.?of.?birth|birth|citizenship|address|street|postal|zip|iban|routing|swift|^bic$|account.?num|account.?number|bank.?account|^accounts?$|^tax|tin$|phone|mobile|hmac|secret|token|password/i;
// Explicit allowlist: only non-sensitive booleans that the pattern would otherwise catch.
export const ALLOWLIST = new Set(["isPhoneVerified"]);
export const isSensitiveKey = (k, v) => !(ALLOWLIST.has(k) && typeof v === "boolean") && (SENSITIVE_KEYS.has(k) || SENSITIVE_PATTERN.test(k));
export function redact(v) {
  if (Array.isArray(v)) return v.map(redact);
  if (!v || typeof v !== "object") return v;
  const o = {};
  for (const [k, x] of Object.entries(v)) if (!isSensitiveKey(k, x)) o[k] = redact(x);
  return o;
}
export const toRecipient = r => r && ({
  id: r.id, referenceId: r.referenceId ?? null,
  email: r.email ?? null, status: r.status ?? null, complianceStatus: r.complianceStatus ?? null,
  payoutMethod: r.payoutMethod ?? null, country: r.address?.country ?? null,
  ...(r.primaryCurrency ? { currency: r.primaryCurrency } : {}), createdAt: r.createdAt ?? null,
});
export const toPayout = p => p && ({
  id: p.id, recipientId: p.recipient?.id ?? null, batchId: p.batch?.id ?? null,
  status: p.status, sourceAmount: p.sourceAmount, sourceCurrency: p.sourceCurrency,
  targetAmount: p.targetAmount, targetCurrency: p.targetCurrency, fees: p.fees, memo: p.memo ?? null, processedAt: p.processedAt ?? null,
});
export const toBatch = b => b && ({
  id: b.id, status: b.status, amount: b.amount, currency: b.currency, totalPayments: b.totalPayments,
  description: b.description ?? null, tags: b.tags ?? [], createdAt: b.createdAt ?? null, sentAt: b.sentAt ?? null, completedAt: b.completedAt ?? null,
});
// Apply default shaping for a resource response (top-level keys).
export function shape(resource, json, { raw = false } = {}) {
  const { ok, ...rest } = json;
  const out = {};
  for (const [k, v] of Object.entries(rest)) {
    if (!raw && (k === "recipient" || k === "recipients") && resource === "recipients") out[k] = Array.isArray(v) ? v.map(toRecipient) : toRecipient(v);
    else if (!raw && (k === "payment" || k === "payments") && resource !== "offline_payments" && resource !== "invoice_payments") out[k === "payment" ? "payout" : "payouts"] = Array.isArray(v) ? v.map(toPayout) : toPayout(v);
    else if (!raw && k === "batches") out[k] = v.map(toBatch);
    else out[k] = redact(v);
  }
  return out;
}
