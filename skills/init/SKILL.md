---
name: init
description: First-time setup and full backfill of the Trolley plugin's local store (all batches, payments with recipientId, and the recipients they reference). Use when the user types /init, or asks to set up, rebuild or backfill the Trolley cache.
---

# /init (read-only toward Trolley)

1. Call `whoami` and tell the user which environment the keys belong to (`sandbox` / `production`). If it says `conflict`, stop.
2. Tell them the backfill runs in a terminal, not in chat, because it takes a long time (see the estimate below). Give them:
   ```sh
   sh ~/.cursor/plugins/local/trolley-plugin/run.sh backfill        # optional: --concurrency 10
   ```
   It prints progress to stderr. It's idempotent and resumable: Ctrl-C and re-run continues from where it stopped (state in `sync_state`).
3. Phases: (1) every batch and its payments, recording `recipientId`; (2) each recipient those payments reference, fetched by ID (GET only, rate-limited by `TROLLEY_RATE_LIMIT`); (3) the recipient watermark is set to the backfill start, so later `sync_cache` runs with `scope: recipients` only sweep changes.
4. **Last, ask whether this device is a laptop or a phone.** Then run `sh ~/.cursor/plugins/local/trolley-plugin/run.sh init --device laptop` or `--device phone`, which writes the config file (mode 0600).
   - Laptop: all three settings `true`. Offer the backfill with `run.sh init --device laptop --backfill`, or run `run.sh backfill`.
   - Phone: all three `false`. Lookups go live. **Never backfill on a phone.** If the config already says phone, skip the backfill (`run.sh backfill` refuses it anyway unless `--force` is given). If the device type isn't known yet, ask before backfilling.
5. Afterwards, `sync_cache` (scope `batches`, `recipients` or `all`) keeps the store current.

Estimate: payments pages of 100 take 13-29 s while Trolley is slow (1-2 s when it's healthy). The payments phase is roughly (payments ÷ 100) × page time ÷ concurrency. The recipients phase is roughly (distinct recipients × ~0.4 s) ÷ concurrency, capped by the rate limit: e.g. 20k recipients at 100/min is ~3.5 h, and at 900/min is ~25 min. Quote this, and recommend a higher `TROLLEY_RATE_LIMIT` if the account allows it.

Privacy: the store keeps recipient email, referenceId, statuses, country, payoutMethod and isPhoneVerified (boolean). It never stores a name or other sensitive fields. The DB file is mode 0600.
