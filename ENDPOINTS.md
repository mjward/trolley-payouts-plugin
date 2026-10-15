# Trolley API v1 endpoint inventory

Sources: https://developers.trolley.com/api/ and https://developers.trolley.com/openapi.yml (80 operations). Base URL `https://api.trolley.com` (sandbox vs live is chosen by the key pair).

Coverage: **80/80 operations implemented (100%)**. `recipients_read.offline_payments` and `offline_payments_read.list_for_recipient` both map to the same endpoint.

Legend: Live = called against sandbox; Dry-run = only the confirm-gated dry-run path verified (no request sent); Live (blocked) = called, Trolley returned an account-permission error.

| Method | Path | Tool | Action | Confirm | Tested |
|---|---|---|---|---|---|
| GET | /v1/recipients | recipients_read | list | no | Live |
| GET | /v1/recipients/:recipientId | recipients_read | get | no | Live |
| GET | /v1/recipients/:recipientId/logs | recipients_read | logs | no | Live |
| GET | /v1/recipients/:recipientId/payments | recipients_read | payments | no | Live |
| GET | /v1/recipients/:recipientId/offlinePayments | recipients_read | offline_payments | no | Live |
| POST | /v1/recipients | recipients_write | create | no | Live (tagged test data) |
| PATCH | /v1/recipients/:recipientId | recipients_write | update | no | Live (tagged test data) |
| DELETE | /v1/recipients/:recipientId | recipients_write | delete | yes | Live (tagged test data) |
| DELETE | /v1/recipients | recipients_write | delete_many | yes | Dry-run only |
| GET | /v1/recipients/:recipientId/accounts/:accountId | recipient_accounts_read | get | no | Live |
| POST | /v1/recipients/:recipientId/accounts | recipient_accounts_write | create | no | Live (tagged test data) |
| PATCH | /v1/recipients/:recipientId/accounts/:accountId | recipient_accounts_write | update | no | Live (tagged test data) |
| DELETE | /v1/recipients/:recipientId/accounts/:accountId | recipient_accounts_write | delete | yes | Live (404 after account update changed the id; see README) |
| GET | /v1/batches | batches_read | list | no | Live |
| GET | /v1/batches/:batchId | batches_read | get | no | Live |
| GET | /v1/batches/:batchId/summary | batches_read | summary | no | Live |
| POST | /v1/batches | batches_write | create | no | Live (tagged test data) |
| POST | /v1/batches/:batchId/generate-quote | batches_write | generate_quote | no | Live (tagged test data) |
| POST | /v1/batches/:batchId/start-processing | batches_write | start_processing | yes (MONEY) | Dry-run only |
| DELETE | /v1/batches/:batchId | batches_write | delete | yes | Live (tagged test data) |
| DELETE | /v1/batches | batches_write | delete_many | yes | Dry-run only |
| GET | /v1/batches/:batchId/payments | payments_read | list_in_batch | no | Live |
| GET | /v1/payments/:paymentId | payments_read | get | no | Live |
| GET | /v1/batches/:batchId/payments/:paymentId | payments_read | get_in_batch | no | Live |
| POST | /v1/batches/:batchId/payments | payments_write | create | if batch not open | Live (tagged test data) |
| PATCH | /v1/batches/:batchId/payments/:paymentId | payments_write | update | if batch not open | Live (tagged test data) |
| DELETE | /v1/batches/:batchId/payments/:paymentId | payments_write | delete | yes | Live (tagged test data) |
| GET | /v1/offline-payments | offline_payments_read | list | no | Live |
| GET | /v1/recipients/:recipientId/offlinePayments | offline_payments_read | list_for_recipient | no | Live |
| POST | /v1/recipients/:recipientId/offlinePayments | offline_payments_write | create | no | Live (tagged test data) |
| PATCH | /v1/recipients/:recipientId/offlinePayments/:offlinePaymentId | offline_payments_write | update | no | Live (tagged test data) |
| DELETE | /v1/recipients/:recipientId/offlinePayments/:offlinePaymentId | offline_payments_write | delete | yes | Live (tagged test data) |
| POST | /v1/invoices/get | invoices_read | get | no | Live |
| POST | /v1/invoices/search | invoices_read | search | no | Live |
| POST | /v1/invoices/create | invoices_write | create | no | Live (tagged test data) |
| POST | /v1/invoices/update | invoices_write | update | no | Live (tagged test data) |
| POST | /v1/invoices/delete | invoices_write | delete | yes | Live (tagged test data) |
| POST | /v1/invoices/create-lines | invoices_write | create_lines | no | Live (tagged test data) |
| POST | /v1/invoices/update-lines | invoices_write | update_lines | no | Live (tagged test data) |
| POST | /v1/invoices/delete-lines | invoices_write | delete_lines | yes | Live (tagged test data) |
| POST | /v1/invoices/payment/search | invoice_payments_read | search | no | Live |
| POST | /v1/invoices/payment/create | invoice_payments_write | create | no | Live (tagged test data) |
| POST | /v1/invoices/payment/update | invoice_payments_write | update | no | Live (tagged test data) |
| POST | /v1/invoices/payment/delete | invoice_payments_write | delete | yes | Live (tagged test data) |
| GET | /v1/balances | balances_read | all | no | Live |
| GET | /v1/balances/paymentrails | balances_read | paymentrails | no | Live |
| GET | /v1/balances/paypal | balances_read | paypal | no | Live |
| GET | /v1/balances/info | balances_read | funding_info | no | Live |
| GET | /v1/verifications | verifications_read | list | no | Live (blocked: 403 for this account) |
| POST | /v1/verifications/watchlist/trigger | verifications_write | trigger_watchlist | yes | Dry-run only |
| POST | /v1/verifications/trigger | verifications_write | trigger | yes | Dry-run only |
| PATCH | /v1/verifications/expire | verifications_write | expire | yes | Dry-run only |
| GET | /v1/subscriptions | webhooks_read | list | no | Live |
| GET | /v1/subscriptions/:subscriptionId | webhooks_read | get | no | Live |
| POST | /v1/subscriptions | webhooks_write | create | no | Live (tagged test data) |
| PATCH | /v1/subscriptions/:subscriptionId | webhooks_write | update | no | Live (tagged test data) |
| DELETE | /v1/subscriptions/:subscriptionId | webhooks_write | delete | yes | Live (tagged test data) |
| POST | /v1/subscriptions/test | webhooks_write | retrigger | no | Live (tagged test data) |
| GET | /v1/geography/countries/:countryCode | reference_read | country | no | Live |
| GET | /v1/fees | partner_read | fees | no | Live |
| POST | /v1/fees/route-pricing/search | partner_read | route_pricing | no | Live |
| GET | /v1/iframe/config | partner_read | widget_config | no | Live |
| GET | /v1/payout-methods | partner_read | payout_methods | no | Live |
| GET | /v1/payout-methods/:payoutMethod | partner_read | payout_method | no | Live |
| GET | /v1/processing-settings | partner_read | processing_settings | no | Live |
| GET | /v1/white-label | partner_read | white_label | no | Live |
| GET | /v1/white-label/dns-records | partner_read | white_label_dns | no | Live |
| PATCH | /v1/fees | partner_write | update_fee_cover | yes | Dry-run only |
| POST | /v1/fees/revenue-stream/create | partner_write | create_revenue_stream | yes | Dry-run only |
| POST | /v1/fees/revenue-stream/update | partner_write | update_revenue_stream | yes | Dry-run only |
| POST | /v1/iframe/config | partner_write | update_widget_config | yes | Dry-run only |
| POST | /v1/onboarding/update | partner_write | update_onboarding | yes | Dry-run only |
| PATCH | /v1/payout-methods/:payoutMethod | partner_write | update_payout_method | yes | Dry-run only |
| PATCH | /v1/processing-settings | partner_write | update_processing_settings | yes | Dry-run only |
| POST | /v1/profile/sandbox | partner_write | create_sandbox_profile | yes | Dry-run only |
| DELETE | /v1/profile/sandbox | partner_write | delete_sandbox_profile | yes | Dry-run only |
| POST | /v1/profile/submerchant | partner_write | create_submerchant | yes | Dry-run only |
| PATCH | /v1/white-label | partner_write | update_white_label | yes | Dry-run only |
| POST | /v1/white-label/dns-records/verify | partner_write | verify_white_label_dns | yes | Dry-run only |
| DELETE | /v1/white-label/email | partner_write | delete_white_label_email | yes | Dry-run only |
| PATCH | /v1/white-label/icon | partner_write | update_white_label_icon | yes | Dry-run only |

Not implemented as API tools: none. Webhook *receiving*/signature verification is server-side (your endpoint), not an API call, so it is out of scope for an MCP client.

## Composite tools

| Tool | Calls | Tested |
|---|---|---|
| sync_cache (read-only toward Trolley) | GET /v1/batches (pageSize 1000, all pages); GET /v1/batches/:id/payments (pageSize 1000, all pages) for non-terminal/changed batches; GET /v1/batches/:id/payments?status=returned&pageSize=1 (undocumented filter, verified sandbox+prod) for recent terminal batches | Live sandbox + prod |
| payout_stats | sync_cache refresh, then SQL over local SQLite | Live sandbox + prod |
| payout_query | none (local read-only SQL) | Live prod |
