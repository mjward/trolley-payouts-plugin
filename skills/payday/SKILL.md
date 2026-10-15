---
name: payday
description: Summarise a Trolley payday cycle (payday is the 15th of each month; the cycle's payout runs are created a few days before). Use when the user types /payday, optionally with a month (e.g. /payday Sep, /payday Oct 2026), or asks how the latest payday went.
---

# /payday (read-only)

1. Call `payday_summary` with `month` set to the user's argument, if any ("Sep", "September", "Oct 2026", "2026-10"). With no argument it uses the most recent payday (TROLLEY_PAYDAY_DAY, default the 15th) on or before today in TROLLEY_TIMEZONE (default Melbourne). Begin with the `statusLine`, which includes the timezone, and relay any `configWarnings`.
2. Give the payday date. Then, for each batch in `batches` (one per `TROLLEY_BATCH_GROUPS` group, or every batch in the window if no groups are set) and **Combined**, write plain lines (no tables):
   - `Status: 🟡 `open``: the label, a colon, then `statusBadge` (an emoji dot plus the status as inline code), on one line.
   - Then one line each for ID, Created (Melbourne), Total (per currency), Successful, Failed and Returned.
3. Leave out Status and ID for Combined.
4. If a batch has `flag`, show it verbatim: **not yet in waiting approval**. Never describe such a batch as "pending".
5. Relay `notes` as-is: missing or ambiguous batches, and which batches were refetched or checked.

Rules:
- Read-only; never call write tools. Report only tool output; don't invent amounts or counts.
- Status colours: 🟢 active/processed/completed, 🟡 incomplete/pending/open/awaiting approval, 🔴 blocked/failed/returned/suspended, ⚪ anything else. Use the `statusBadge` string as given. The JSON keeps the raw `status`. No images or tables.
- Mention `environment` (sandbox/production) from the result if it isn't production, or if it's `unknown`.

## Other batches this month
If `otherBatchesThisMonth` isn't empty, add an **Other batches this month** section: one line each with label, `Status: <statusBadge>`, created date and payment count. These aren't counted in the cycle. Mid-month runs that reuse a group's label may be re-runs; don't speculate about them.

## Amounts
`totalAmount` is the **sum of the payments' sourceAmount**, the same set the successful/failed/returned counts come from. Label it "Total (sum of payments)". Trolley's own `batchAmount` can differ. When `batchAmountMinusPaymentSum` isn't zero, add a line: `Batch amount (Trolley): …`, with the difference and `paymentFees`. Don't guess at the reason.

If `otherStatuses` isn't empty (for example payments still `pending` in a processing batch), add a line like `Other: 236 (pending 230, …)`. These are payment statuses, not batch statuses. Successful + failed + returned + other = totalPayments.
