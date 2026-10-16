# Trolley payouts plugin for Cursor

This is an MCP plugin for Cursor that connects to [Trolley](https://www.trolley.com), the payouts platform. MCP (Model Context Protocol) is the standard Cursor uses to give its AI chat extra tools. With this plugin you can ask about payment batches, payouts and recipients in plain English, get a summary of each monthly payday, and get a Mac notification when a payday batch moves, gets stuck or has too many failed payments. It keeps an optional local copy of your payment data so answers are fast, and it keeps that copy up to date on a schedule. The payday, recipient, sync and monitor features only ever read from Trolley. The plugin also has general tools that can change data in Trolley; those always ask for an explicit confirmation and do a dry run otherwise.

## Quick start

You need macOS (for the scheduled jobs and notifications), Node.js 22.5 or newer, and a Trolley API key pair (Trolley dashboard, Settings, API Keys).

1. Copy this folder to `~/.cursor/plugins/local/trolley-plugin`.
2. Add your keys to `~/.zshrc`, then open a new terminal:
   ```sh
   export TROLLEY_ACCESS_KEY=your-access-key
   export TROLLEY_SECRET_KEY=your-secret-key
   export TROLLEY_ENVIRONMENT=production   # or sandbox
   ```
3. Run the first-time setup. It asks whether this is a laptop or a phone and writes the config file:
   ```sh
   sh ~/.cursor/plugins/local/trolley-plugin/run.sh init --device laptop
   ```
   Then fill the local copy (this can take an hour on a big account, and you can stop and restart it):
   ```sh
   sh ~/.cursor/plugins/local/trolley-plugin/run.sh backfill
   ```
4. Add the plugin to `~/.cursor/mcp.json` and restart Cursor:
   ```json
   {
     "mcpServers": {
       "trolley": {
         "command": "sh",
         "args": ["/Users/YOU/.cursor/plugins/local/trolley-plugin/run.sh"]
       }
     }
   }
   ```
   `run.sh` reads your keys and settings from `~/.zshrc` and finds a suitable Node, so you don't need to put keys in `mcp.json`.

## Commands and skills

- `/payday [month]` summarises a payday: each payout run's status, payment count, total and failures.
- `/recipient <id, email or reference>` looks up one recipient.
- `/init` (or `sh run.sh init --device laptop|phone`) sets up the plugin on a device.
- `sh run.sh backfill` fills the local copy from scratch. It resumes if interrupted.
- `sh run.sh sync payments|recipients [--dry-run]` runs one sync by hand.
- `sh run.sh schedule install|uninstall|status [--agent|--monitor]` manages the scheduled jobs.
- `sh run.sh monitor run [--dry-run] [--date YYYY-MM-DD]` runs one payday monitor check. `sh run.sh monitor test-notify` sends a test notification.

## Configuration

Set these as `export NAME=value` lines in `~/.zshrc`. `run.sh` only reads the names on its allowlist from that file (marked "yes" below) and never runs anything else in it. Settings without a "yes" have to be set in the environment some other way, for example in the `env` block of `mcp.json` or the launchd job.

The three cache switches can also live in the config file `~/.config/trolley-plugin/config.json` (or the path in `TROLLEY_CONFIG_FILE`), which `init` writes. An environment variable always overrides the config file.

| Name | Default | What it changes | In ~/.zshrc |
|---|---|---|---|
| **Credentials** | | | |
| `TROLLEY_ACCESS_KEY` | none (required) | Your Trolley API access key. | yes |
| `TROLLEY_SECRET_KEY` | none (required) | Your Trolley API secret key. | yes |
| **Environment safety** | | | |
| `TROLLEY_ENVIRONMENT` | unset | Says whether the keys are `sandbox` or `production`. Shown on every answer. | yes |
| `TROLLEY_KNOWN_KEYS` | unset | List of `fingerprint=sandbox,fingerprint=production`. A fingerprint is the first 12 characters of the key's SHA-256 hash; `whoami` shows yours. If this and `TROLLEY_ENVIRONMENT` disagree, every call is refused. | yes |
| **Payday** | | | |
| `TROLLEY_TIMEZONE` | `Australia/Melbourne` | Time zone for payday dates and times. | yes |
| `TROLLEY_PAYDAY_DAY` | `15` | Day of the month that is payday (cut to the month's last day if needed). | yes |
| `TROLLEY_BATCH_CREATE_DAY` | `11` | Day the payout runs are usually created. `/payday` searches from 3 days before this through payday. | yes |
| `TROLLEY_BATCH_GROUPS` | unset | Comma-separated group names, e.g. `Group A,Group B`. Each batch is matched to a group by whole words in its description, ignoring case. Unset means every batch in the cycle is shown together. | yes |
| **Caching & sync** | | | |
| `TROLLEY_RECIPIENT_CACHE` | `true` | Keep a local copy of recipients. Off means every lookup goes live to Trolley. Also `recipientCache` in the config file. | yes |
| `TROLLEY_PAYMENT_CACHE` | `true` | Keep a local copy of batches and payments. Off means `/payday` and stats go live, and `payout_query` stops working. Also `paymentCache` in the config file. | yes |
| `TROLLEY_SYNC_ENABLED` | `true` | Allow backfill and scheduled syncs. Also `syncEnabled` in the config file. | yes |
| `TROLLEY_CONFIG_FILE` | `~/.config/trolley-plugin/config.json` | Where the config file is. | yes |
| `TROLLEY_DB_PATH` | `~/.cache/trolley-plugin/trolley.db` | Where the local copy is stored. One file is kept per key, so sandbox and production never mix. | |
| `TROLLEY_FINAL_AFTER_DAYS` | `120` | How long a finished batch is still checked for late returned payments. | |
| `TROLLEY_SYNC_MAX_PAGES` | `1000` | Safety limit on pages read in one scheduled sync run. | |
| `TROLLEY_BACKFILL_PASSES` | `3` | How many times the backfill retries recipients that failed. | |
| `TROLLEY_BULK_COST_FACTOR` | `25` | How much slower one 1,000-row page is than one single lookup. Used to choose how the backfill loads recipients. | |
| `TROLLEY_RECIPIENT_RETRIES` | `2` | Retries for a single recipient lookup during backfill. | |
| `TROLLEY_RETRY_WAIT_MS` | `2000` | Wait between those retries, in milliseconds. | |
| `TROLLEY_LOG_DIR` | `~/Library/Logs/trolley-plugin` | Where the scheduled jobs write their logs. | |
| **Payday monitor** | | | |
| `TROLLEY_PAYDAY_MONITOR` | `true` | Turns the payday monitor on or off. | yes |
| `TROLLEY_FAIL_RATE_WARN` | `3` | Warn when failed plus returned payments go over this percentage... | yes |
| `TROLLEY_FAIL_MIN_COUNT` | `25` | ...and there are at least this many of them. | yes |
| `TROLLEY_FAIL_RATE_HIGH` | `10` | Warn again over this percentage. | yes |
| `TROLLEY_FAIL_SMALL_BATCH_SIZE` | `300` | Batches with fewer payments than this use the small-batch rule instead. | yes |
| `TROLLEY_FAIL_SMALL_BATCH_COUNT` | `10` | Small-batch rule: warn at this many failures. | yes |
| `TROLLEY_NOTIFY_EMAIL` | unset | Reserved for email alerts. Not built yet, so it does nothing. | yes |
| **Performance** | | | |
| `TROLLEY_RATE_LIMIT` | `100` | Most requests per minute sent to Trolley (maximum 2000). | yes |
| `TROLLEY_RATE_LIMIT_PER_MIN` | `100` | Older name for the same setting. `TROLLEY_RATE_LIMIT` wins if both are set. | yes |
| `TROLLEY_CONCURRENCY` | `4` | How many requests run at once (maximum 20). | yes |
| `TROLLEY_PAGE_SIZE` | `100` | Rows per page when reading payments (10 to 1000). Smaller pages come back faster when Trolley is slow. | yes |
| `TROLLEY_REQUEST_TIMEOUT_MS` | `180000` | Give up on one request after this many milliseconds (minimum 5000). | yes |
| `TROLLEY_QUERY_TIMEOUT_MS` | `5000` | Time limit for a local `payout_query` search, in milliseconds. | |

## Scheduled jobs

Three jobs run through launchd, the Mac's built-in scheduler. They don't wake a sleeping Mac; a missed run happens once when it wakes.

- Payment sync runs every hour at 7 minutes past. It fetches payments that changed since the last run, and every 6 hours it also checks for late returned payments.
- Recipient sync runs at 00:37, 06:37, 12:37 and 18:37. It skips payday.
- The payday monitor checks every 15 minutes, but only for 48 hours from midnight on payday (moved to Monday if payday is on a weekend). It sends a Mac notification when a batch changes stage. It warns if a group's batch is missing at 09:00, still waiting for approval at 12:00 or still processing at 17:00, once each on both days. It also warns when failures pass the thresholds above. It only runs while you're logged in.

Install the two syncs with `sudo sh run.sh schedule install` (this lets them run even when you're logged out), or with `sh run.sh schedule install --agent` to run them only while you're logged in. Install the monitor with `sh run.sh schedule install --monitor`. Check them with `sh run.sh schedule status`.

Logs are in `~/Library/Logs/trolley-plugin/`: `payment-sync.log`, `recipient-sync.log` and `payday-monitor.log`. Each is rotated at 1 MB, and 5 old copies are kept.

To pause a sync, run `sudo launchctl disable system/com.trolley-plugin.payment-sync` (or `recipient-sync`), and `enable` to resume. To pause the monitor, set `TROLLEY_PAYDAY_MONITOR=false`. To remove them, run `sudo sh run.sh schedule uninstall` for the syncs and `sh run.sh schedule uninstall --monitor` for the monitor.

## Privacy and safety

- The payday, recipient, sync and monitor features only send GET requests, which read and never change anything.
- Tools that can change data in Trolley need `confirm: true`. Without it they only show what they would have done.
- Sensitive fields (tax, bank, address, phone, date of birth, government IDs) are never stored or shown. There is no option to include them.
- Recipient names are never stored or shown.
- Keys are never printed or stored. Only a short fingerprint is shown.
- The local copy and config file can only be read by your user account.

More detail on how it works is in [docs/INTERNALS.md](docs/INTERNALS.md), and every Trolley endpoint covered is listed in [ENDPOINTS.md](ENDPOINTS.md).

## Development

There are no npm dependencies. Run the tests with Node 22.5 or newer:

```sh
npm test
```
