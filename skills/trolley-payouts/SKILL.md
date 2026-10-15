---
name: trolley-payouts
description: Work with Trolley payouts — recipients, batches, payments, offline payments, invoices, balances, verifications, webhooks. Use when the user asks about Trolley payout status, amounts, fees, batches, recipients or balances, or asks to prepare (not send) payouts.
---

# Trolley payouts

Tools are `<resource>_read` (read-only) and `<resource>_write` (writes), each taking an `action` argument.
Resources: recipients, recipient_accounts, batches, payments, offline_payments, invoices, invoice_payments, balances, verifications, webhooks, reference, partner.

Reading:
- Start with `*_read`. Use `batches_read {action:"list"}` to find B- ids, `payments_read` for payouts (normalized to Payout), `recipients_read` for recipients (trimmed RecipientSummary).
- Lists accept `page`/`pageSize` (max 1000) or `all:true` (auto-paginate, capped by `maxPages`, default 20; check `meta.truncated`).
- Report only what tools return. Never invent ids, amounts, statuses or currencies. Quote amounts exactly, with currency.
- **Never request or display sensitive recipient data** (SSN/government IDs, DOB, passport, address, bank account/IBAN/routing/SWIFT numbers, tax details, phone, webhook secrets). The tools strip it, even with `raw:true`, and reject `includeSensitive`. If the user needs it, point them to the Trolley dashboard.

Stats & SQL (local SQLite store, no PII):
- `payout_stats` refreshes the store first. Non-terminal and latest batches are always refetched, and recent terminal batches are checked for late returns. Then it reports the range, counts per status, exact amounts per currency, both fail rates with denominators, and `dataAsOf`.
- `sync_cache` refreshes explicitly (`full`, `force`). `payout_query` runs one read-only SELECT/WITH over:
  - `batches(id, status, tags JSON, amount, currency, totalPayments, createdAt, sentAt, completedAt, updatedAt, returnedCount, lastSyncedAt)`
  - `payments(id, batchId, status, sourceAmount, sourceCurrency, targetAmount, targetCurrency, fees, payoutMethod, country, createdAt, processedAt, returnedAt, settledAt, updatedAt, failureReason, returnReason, lastSyncedAt)`
  - Amounts are TEXT (CAST for math). Dates are ISO UTC. The payment date is `coalesce(processedAt, createdAt)`.
- Example queries:
  - Fail rate by method by month: `SELECT substr(coalesce(processedAt,createdAt),1,7) m, payoutMethod, count(*) n, round(1.0*sum(status IN ('failed','returned'))/count(*),4) failRate FROM payments GROUP BY 1,2 ORDER BY 1,2`
  - Return lag: `SELECT p.batchId, max(julianday(p.returnedAt)-julianday(b.sentAt)) lagDays FROM payments p JOIN batches b ON b.id=p.batchId WHERE p.status='returned' GROUP BY 1 ORDER BY 2 DESC LIMIT 10`
  - Top return codes: `SELECT returnReason, count(*) FROM payments WHERE status='returned' GROUP BY 1 ORDER BY 2 DESC`
- Run `sync_cache` before `payout_query` if `meta.lastSyncAt` is old. Prefer `payout_stats` for exact money totals.

Writing:
- Only write when the user asked for that specific change.
- Calls marked "needs confirm" return a dry run `{dryRun, wouldCall, reason}` without `confirm:true`. Show the dry run to the user and only re-run with `confirm:true` after they explicitly approve.
- `batches_write start_processing` SENDS REAL MONEY and cannot be undone. Never confirm it without explicit approval of that batch, its total and currency.
- Deleting a recipient archives it.
- Relay Trolley errors (`code (field): message`) as-is.

- Show statuses as an emoji dot plus inline code (e.g. `Status: 🟡 `incomplete``). Use `statusBadge` / `complianceBadge` when present. 🟢 active/processed/completed, 🟡 incomplete/pending/open/awaiting approval, 🔴 blocked/failed/returned/suspended, ⚪ anything else.
- Every result has an `environment` field (sandbox | production | unknown). Call `whoami` if unsure, and state the environment when it matters.
