# trolley — Trolley payouts Agent Plugin

Zero-dependency stdio MCP server (Node 18+) covering the whole [Trolley API v1](https://developers.trolley.com/api/) — 80/80 operations, see [ENDPOINTS.md](ENDPOINTS.md).

## Tools (23)
One `<resource>_read` and one `<resource>_write` tool per resource, each with an `action` enum:
recipients, recipient_accounts, batches, payments, offline_payments, invoices, invoice_payments, balances, verifications, webhooks, reference (read only), partner.

**Why this layout:** 80 tiny tools would make `tools/list` unreadable. One tool per resource can't carry honest MCP annotations, because it would mix reads and deletes. A read/write split gives 22 tools: every `_read` tool is `readOnlyHint:true`, and every `_write` tool is `destructiveHint:true`.

Common args: ids (`recipientId`, `batchId`, `paymentId`, `accountId`, `offlinePaymentId`, `subscriptionId`, `countryCode`, `payoutMethod`; prefixes validated), `query` (filters), `body` (JSON body per docs), `page`/`pageSize`, `all`/`maxPages`, `raw`, `confirm`.

## recipient_lookup and the /recipient skill (read-only)
Paste a recipient ID or an email. Whitespace, `mailto:`, `<…>` and quotes are stripped.
- `R-…` ids go to `GET /recipients/:id`.
- Emails are matched exactly (case-insensitively) and must resolve to a single recipient; more than one match returns an ambiguity error. Trolley's `email` filter is case-sensitive, so the tool calls the exact filter, then `search`, then the lowercased filter if both missed. If there's still no match it tries the ID path, then returns a clear not-found.
- Returns `{matchedBy, recipient: {id, referenceId, name, email, status, complianceStatus, payoutMethod, country, isPhoneVerified, createdAt}}` and never sensitive fields. Each environment's keys only see that environment's recipients.

## payday_summary and the /payday skill (read-only)
Payday is the 15th by default (`TROLLEY_PAYDAY_DAY`, in `TROLLEY_TIMEZONE`, default Australia/Melbourne). Each cycle's payout runs are created a few days before payday (`TROLLEY_BATCH_CREATE_DAY`, default the 11th). The tool looks for payment batches created from 3 days before that through the end of payday. Set `TROLLEY_BATCH_GROUPS` (e.g. `"Group A,Group B"`) to pick one batch per group: groups match whole words in the batch description, case-insensitive, and a `YYYY-MM <group>` prefix ranks a candidate first. With no groups set, every batch in the window is listed together. The `YYYY-MM` label month doesn't have to match the payday month. Re-run batches created after payday are listed as other batches, not counted.
- `month`: "Oct", "October", "Oct 2026" or "2026-10". With a bare month name it uses that month's most recent payday on or before today. With no `month` it uses the most recent 15th on or before today (Melbourne).
- Output, per batch and combined: total amount per currency (exact), successful/failed/returned counts, id, status, createdAt (Melbourne). A batch still `open` gets `flag: "not yet in waiting approval"`. Observed statuses: `open` → `awaiting_approval` → `processing` → `complete`/`failed`.
- Data: one `GET /batches?startDate=<window start>`, then only those two batches are refreshed if the local copy may be behind: non-terminal, never synced, or completed <120 days with a changed returned count.

## Environment check (whoami)
Sandbox and live share `https://api.trolley.com` and Trolley exposes no documented sandbox flag, so the plugin identifies the environment from configuration, never from the key itself:
- `TROLLEY_KNOWN_KEYS="<fp>=sandbox,<fp>=production"`: fingerprints are `sha256(accessKey)` hex, first 12 characters. They're safe to share, and `whoami` shows the current one.
- `TROLLEY_ENVIRONMENT=sandbox|production` (declared).
- If the two disagree (for example a prod key loaded where sandbox was declared), every Trolley call is refused. If neither is set, `environment` is `unknown`. Every tool result includes `environment`.
- For tests, run in a clean env (`env -i PATH=… HOME=… TROLLEY_ACCESS_KEY=… TROLLEY_SECRET_KEY=… TROLLEY_ENVIRONMENT=sandbox`) so shell variables can't leak in.

## Requirements
Node **>= 22.5** (uses the built-in `node:sqlite`; zero npm dependencies). `server/index.mjs` exits with a clear message on older Node. If the `node` on PATH is too old, set `mcp.json` `"command"` to a newer binary, e.g. `~/.asdf/installs/nodejs/24.x/bin/node`.

## Local store (SQLite) — sync_cache, payout_stats, payout_query
- **File:** `TROLLEY_DB_PATH` (default `~/.cache/trolley-plugin/trolley.db`). There's one file per environment: `trolley-<sha256(accessKey)[:12]>.db`, so sandbox and prod never mix. The key itself is never stored. Files are 0600 in a 0700 directory, using WAL.
- **Schema (no PII):** no names, emails, recipient ids, addresses, memos or account details.
  - `batches(id PK, status, tags JSON, amount, currency, totalPayments, createdAt, sentAt, completedAt, updatedAt, returnedCount, lastSyncedAt)`
  - `payments(id PK, batchId FK, status, sourceAmount, sourceCurrency, targetAmount, targetCurrency, fees, payoutMethod, country, createdAt, processedAt, returnedAt, settledAt, updatedAt, failureReason, returnReason, lastSyncedAt)`
  - Reason columns hold short error codes only.
- **Refresh** (shared by `sync_cache` and `payout_stats`; GET only):
  1. List all batches (pageSize 1000) and upsert them. Batches no longer listed are removed.
  2. Non-terminal batches (anything except `complete`/`failed`) always get a full payment refetch.
  3. Terminal batches completed less than `TROLLEY_FINAL_AFTER_DAYS` ago (default 120) get one cheap call: `GET /batches/:id/payments?status=returned&pageSize=1`. If `meta.records` differs from the stored `returnedCount`, or the batch was never synced, or its `updatedAt`/status changed, it's refetched. This check exists because Trolley does **not** bump batch `updatedAt` when a payment is returned later; in prod a third of returns arrived 1–11 weeks after completion.
  4. Older terminal batches are synced once, then treated as final. `full:true` checks them too, and `force:true` refetches everything.
  - Each batch is replaced in one transaction, upserting by payment id and dropping deleted payments, so runs are idempotent.
- **`payout_stats`:** refreshes (unless `skipRefresh`), then computes from SQL with exact decimal sums. Output includes `refresh` (calls, refetched, checked, changed) and `dataAsOf`.
- **`payout_query`:** read-only SQL over the store. Safeguards:
  - Only a single `SELECT`/`WITH` statement is accepted. `PRAGMA`, `ATTACH`, writes and transaction keywords are rejected by a text guard.
  - The DB is opened `readOnly`, and an SQLite authorizer allows only SELECT/READ/FUNCTION/RECURSIVE.
  - Rows are capped at 1000. Queries time out after `TROLLEY_QUERY_TIMEOUT_MS` (default 5000) in a child process that is SIGKILLed.
- **Known cost:** every refresh refetches all payments of non-terminal batches. Large processing batches can take many minutes to refresh when Trolley is slow. Use `payout_stats {skipRefresh:true}` for instant answers on already-synced data.
- **Rate limit and concurrency:** `TROLLEY_RATE_LIMIT_PER_MIN` (default 45, cap 2000) and `TROLLEY_CONCURRENCY` (default 4, cap 20), or per call. The token bucket is shared, concurrency halves on repeated 429s, `Retry-After` is honoured, and failed GETs are retried.

## Shapes
- `Payout = { id, recipientId, batchId, status, sourceAmount, sourceCurrency, targetAmount, targetCurrency, fees, memo, processedAt }` (payments; `raw:true` for the full object).
- `RecipientSummary = { id, referenceId, name, email, status, complianceStatus, payoutMethod, country, currency?, createdAt }`.
- `BatchSummary = { id, status, amount, currency, totalPayments, description, tags, createdAt, sentAt, completedAt }` (batch lists).
- Everything else is returned as-is, minus sensitive fields.

## Sensitive data policy (no bypass)
Sensitive recipient data is **never** returned: SSN/government IDs, DOB, passport/birthplace/citizenship, address/street/postal code, bank account/IBAN/routing/SWIFT numbers, tax fields, phone, and webhook hmac secrets. These are stripped recursively by key name and pattern in every tool, including with `raw:true`. Any call that passes `includeSensitive` is rejected with a policy error. Recipient summaries keep only `country`. Allowlist (booleans only): `isPhoneVerified`. Use the Trolley dashboard for sensitive details.

## Safety
- `confirm:true` is required for: all deletes, `batches.start_processing` (MONEY), verification trigger/expire, and every partner write. `payments.create/update` also need it when the batch is not `open`. Without it you get a dry run (`{dryRun, wouldCall, body, reason}`) and nothing is sent.
- Rate limits: a 429 is retried up to 3× and honours `Retry-After` (seconds or HTTP-date, capped at 60s). Each attempt is re-signed.

## Setup
Set `TROLLEY_ACCESS_KEY` / `TROLLEY_SECRET_KEY` (Dashboard > Settings > API Keys). Sandbox vs live is decided by which key pair you use. Never commit keys.

## Auth
`Authorization: prsign <ACCESS_KEY>:<hex HMAC-SHA256(secret, ts\nMETHOD\npath+query\nbody\n)>` plus `X-PR-Timestamp` (must be within 30s of UTC). The exact path+query and body string that are sent are the ones signed.

## Known API quirks (sandbox)
- Updating a recipient account may return a new account id. Use the id from the update response for later calls.
- Deleting a recipient archives it, and archived recipients are hidden from the default list (`query:{status:"archived"}` shows them). Their accounts can't be deleted after archiving.
- `invoice_payments search` requires `invoiceIds` or `paymentIds` in `body`.

## Test
    node --test test/*.test.mjs   (Node >= 22.5)

## Status badges
`statusBadge`/`complianceBadge` (recipient_lookup, payday_summary) is an emoji dot plus inline code, e.g. 🟡 `incomplete`. 🟢 active/processed/completed, 🟡 incomplete/pending/open/awaiting approval, 🔴 blocked/failed/returned/suspended, ⚪ anything else. Raw `status` is unchanged.

## Configuration (env or ~/.zshrc)
`run.sh` (the MCP command) loads these `export` lines from `~/.zshrc` when they aren't already set in the environment. It reads only the allowlist `TROLLEY_(ACCESS_KEY|SECRET_KEY|ENVIRONMENT|KNOWN_KEYS|RATE_LIMIT|RATE_LIMIT_PER_MIN|CONCURRENCY|CACHE_DIR|REQUEST_TIMEOUT_MS|PAGE_SIZE|RECIPIENT_CACHE|PAYMENT_CACHE|SYNC_ENABLED|CONFIG_FILE|TIMEZONE|PAYDAY_DAY|BATCH_CREATE_DAY|BATCH_GROUPS|PAYDAY_MONITOR|NOTIFY_EMAIL|FAIL_RATE_WARN|FAIL_RATE_HIGH|FAIL_MIN_COUNT|FAIL_SMALL_BATCH_COUNT|FAIL_SMALL_BATCH_SIZE)`. It also finds a Node >= 22.5 (PATH, then asdf, Homebrew or nvm).
```sh
export TROLLEY_TIMEZONE=Australia/Sydney   # IANA name; default Australia/Melbourne
export TROLLEY_PAYDAY_DAY=15               # 1-31, clamped to the month length; default 15
export TROLLEY_BATCH_GROUPS="Group A,Group B"  # optional; whole-word, case-insensitive match on batch description; unset = list all batches in the cycle
export TROLLEY_BATCH_CREATE_DAY=11         # 1-31, clamped; default 11
```
All payday dates use TROLLEY_TIMEZONE, and the result's `statusLine` shows it. The batch search runs from (BATCH_CREATE_DAY − 3) to the end of PAYDAY_DAY. If the create day is after the payday day, the window starts in the previous month. An invalid value falls back to its default, with a warning on stderr and in `configWarnings`.

### Amounts in payday_summary
`totalAmount` is the sum of the payments' `sourceAmount` (matching the counts). `batchAmount` is Trolley's `batch.amount`, shown alongside with `batchAmountMinusPaymentSum`, `paymentFees` and `paymentTargetSum` for reconciliation. They can differ. Classification uses `TROLLEY_BATCH_GROUPS` (whole words, case-insensitive). The `YYYY-MM` prefix is not the payday month.

`TROLLEY_REQUEST_TIMEOUT_MS` (default 180000) aborts a stuck request; GETs are retried.

## Rate limit
`TROLLEY_RATE_LIMIT` (requests/min, default 100, max 2000) is the main setting. `TROLLEY_RATE_LIMIT_PER_MIN` is an alias; if both are set, `TROLLEY_RATE_LIMIT` wins. A single token bucket covers every Trolley API call: tools, `sync_cache`/cache builds, `payout_stats`, `payday_summary` and `recipient_lookup`. A per-call `rateLimitPerMin` overrides it for sync and stats runs.

## recipient_lookup routing
`R-…` uses `GET /recipients/:id`. Input containing `@` is treated as an email (exact, case-insensitive match). Anything else, including UUIDs, is treated as a reference ID: `GET /recipients?referenceId=` (an exact filter; `search=` is a LIKE prefix match), and the returned `referenceId` must equal the input exactly. If that fails, it falls back to the ID path. `matchedBy` is `id`, `email` or `referenceId`.

`TROLLEY_PAGE_SIZE` (10-1000, default 100) sets the page size for payment listings. Trolley's response time grows with page size: for a large processing batch, 1000-row pages can take minutes while 100-row pages take seconds. Smaller pages fetched in parallel finish sooner. payday_summary uses concurrency of at least 10.

## Recipient cache, sync scopes and /init
- Tables: `recipients(id, referenceId, email, country, payoutMethod, status, complianceStatus, isPhoneVerified 0/1, createdAt, updatedAt, lastSyncedAt)`, `sync_state(key, value)`, plus `payments.recipientId` (an opaque ID, added by an additive migration).
- **Privacy:** storing email is owner-approved. **Names are sensitive**: `name`/`firstName`/`lastName` are stripped from every tool output and never stored. An old `name` column is dropped and the DB VACUUMed on open. Tax, bank, address, phone, DOB and government IDs are never stored. The DB is mode 0600. There is no includeSensitive option.
- `/recipient` shows the ID, email, referenceId and statuses, never a name. Bulk tools (`payout_stats`, `payout_query`, `payday_summary`) output only IDs and counts. `payout_query` can't read `recipients`; use the `recipient_facts` view (no email).
- Lazy fill: any payment `recipientId` missing from `recipients` is fetched with `GET /recipients/:id` (a 404 becomes a `not_found` stub). `sync_cache` fills up to 500 per run.
- Watermark sweep (`sync_cache` scope `recipients` or `all`): `GET /recipients?startDate=<watermark − 2 min>&endDate=<sweep start>&orderBy=updatedAt&sortBy=asc`, pageSize 1000. Only recipients already in the table are upserted (duplicates dedupe to the newest). The watermark moves to the max `updatedAt` seen, or to the sweep start if nothing was returned. That happens in one transaction, only after the whole sweep succeeds. The first run with no watermark just sets it to now.
- `/init` / `sh run.sh backfill`: batches and payments, then every referenced recipient, then the watermark is set to the backfill start. It's idempotent and resumable, prints progress, and is read-only. See skills/init for time estimates.
- `recipient_lookup` routing: UUID → `?referenceId=` (exact). Input containing `@` → `?email=` (exact, case-insensitive). `R-…` → `/recipients/:id`. Anything else → `?search=`: one hit returns it; several return up to 10 candidates plus `count`. Live is tried first; if the live call fails (not a 404), the cached row is returned (`source: "cache"`).

## Cache and sync switches
Three independent booleans (`true` or `false`; any other value is ignored with a warning). Precedence: env var, then the config file, then the default `true`. All are allowlisted in `run.sh`.

| Env var | Config key | When `false` |
|---|---|---|
| `TROLLEY_RECIPIENT_CACHE` | `recipientCache` | `recipient_lookup` is live-only, nothing is read from or written to `recipients`, no lazy fill, no sweep |
| `TROLLEY_PAYMENT_CACHE` | `paymentCache` | `payout_stats` and `payday_summary` fetch live into a throwaway in-memory DB, so nothing touches disk. `payout_query` returns a "payment cache disabled" error. No lazy fill, since that needs cached payments |
| `TROLLEY_SYNC_ENABLED` | `syncEnabled` | `sync_cache`, `run.sh backfill` and any scheduled sync are no-ops that report `sync disabled`. A tool's own targeted refresh (for example payday's two batches) still runs when its cache is on |

Config file: `TROLLEY_CONFIG_FILE` or `~/.config/trolley-plugin/config.json`, mode 0600, written by `/init` (`sh run.sh init --device laptop|phone`). On a laptop all three are `true`; on a phone all three are `false` and nothing is backfilled. `run.sh backfill` refuses on a phone config unless `--force` is given.
```json
{ "device": "laptop", "recipientCache": true, "paymentCache": true, "syncEnabled": true }
```

## Superseded: daily sync (see Scheduled syncs)
- About 06:00 Australia/Melbourne each day, run `sync_cache` with `scope: "all"` (only if `syncEnabled`).
- Skip the run on days a payday batch is detected: a payment batch in a configured group (any batch, if no groups are set) in the current cycle window that isn't terminal (`open`, `awaiting_approval` or `processing`), so sync doesn't compete with payday traffic.
- A skipped day doesn't advance the recipient watermark. The next run sweeps from the old watermark (minus the 2-min overlap), so nothing is missed.

### Recipients phase strategy
Backfill only loads recipients whose IDs appear on cached payments (`SELECT DISTINCT recipientId …`). It picks the cheaper of two strategies:
- per-ID: one `GET /recipients/:id` per missing ID
- bulk: `GET /recipients?pageSize=1000` across all pages, keeping only the referenced IDs. Stored fields are identical and a name is never stored. Completed pages are recorded in `sync_state`, so it resumes.

Bulk is chosen when pages × `TROLLEY_BULK_COST_FACTOR` (default 25, an estimate of how much slower one 1000-row page is than one ID call) < missing IDs. Any referenced ID the bulk listing doesn't return is then fetched by ID.

## Scheduled syncs (launchd, macOS)

- `payment-sync` runs hourly at :07. It walks `GET /v1/payments?orderBy=updatedAt&sortBy=desc` until it passes the payment watermark (`payments.updatedAtWatermark`) minus 2 minutes. It upserts by id (idempotent), and the watermark moves only after a successful run. Every 6 h the same job also checks `status=returned` on each batch created in the last 90 days.
- `recipient-sync` runs at 00:37, 06:37, 12:37 and 18:37 local time. It uses the recipient `updatedAt` watermark (2-minute overlap) and updates cached recipients only. It skips payday days, and the watermark isn't advanced on a skipped day.
- Both jobs honour `syncEnabled`, `paymentCache` and `recipientCache`, and read keys through run.sh. Neither makes AI calls. They share a lock with the backfill (`sync.lock` next to the DB) and skip the run if a backfill process is found.
- Commands:
  - `sh run.sh sync payments|recipients [--dry-run]` runs one sync by hand.
  - `sh run.sh schedule install|uninstall|status [--agent]`: the default is a LaunchDaemon (needs sudo once); `--agent` installs a LaunchAgent instead (only while you're logged in, no sudo).
- Logs: `~/Library/Logs/trolley-plugin/{payment,recipient}-sync.log`, rotated at 1 MB with 5 kept.

## Payday monitor (LaunchAgent, macOS)

- Runs every 15 minutes (:00/:15/:30/:45), but only during a 48-hour window from 00:00 (`TROLLEY_TIMEZONE`, default Australia/Melbourne) on payday: `TROLLEY_PAYDAY_DAY` (default 15), clamped to the month and moved to Monday when it falls on a weekend (no public holidays), plus the following day. Outside the window it exits straight away with no API calls.
- Each run takes one live `GET /batches` (most recent 100, any status). It tracks this cycle's batch for each `TROLLEY_BATCH_GROUPS` group (or every batch in the window if none are set), plus any other batch created in the cycle window.
- Notifies on: a new batch; a move to waiting for approval, approved (processing), complete or failed.
- Stuck alerts (once per batch per day, on both days; day-2 alerts say "day 2"): a configured group's batch missing at 09:00; still waiting for approval at 12:00; still processing at 17:00. Transition and failure-rate alerts fire once across the whole window.
- Failure rate (processing/complete batches): 2 calls per batch (`status=failed` and `status=returned`, `pageSize=1`, read `meta.records`). Warns once when the rate is above `TROLLEY_FAIL_RATE_WARN` (3%) and there are at least `TROLLEY_FAIL_MIN_COUNT` (25). Batches under `TROLLEY_FAIL_SMALL_BATCH_SIZE` (300) payments warn at `TROLLEY_FAIL_SMALL_BATCH_COUNT` (10) or more. Escalates once above `TROLLEY_FAIL_RATE_HIGH` (10%).
- Delivery: macOS notification (osascript) plus `~/Library/Logs/trolley-plugin/payday-monitor.log`. `TROLLEY_NOTIFY_EMAIL` is a placeholder for future email delivery and does nothing yet.
- State: `~/.cache/trolley-plugin/payday-monitor-state.json` (0600). Lock: `payday-monitor.lock`. The on/off switch is `TROLLEY_PAYDAY_MONITOR` (default true).
- `sh run.sh monitor run [--dry-run] [--date YYYY-MM-DD] [--now ISO]` (`--date` uses the current Melbourne time of day on that date), `sh run.sh monitor test-notify`, `sh run.sh schedule install|uninstall|status --monitor`.
- Pause: `TROLLEY_PAYDAY_MONITOR=false` in `~/.zshrc`, or `launchctl bootout gui/$(id -u)/com.trolley-plugin.payday-monitor`. Remove: `sh run.sh schedule uninstall --monitor`.
