// Route table: every Trolley API v1 endpoint (docs + /openapi.yml). Grouped by resource; each resource
// exposes a <resource>_read tool (readOnly) and, if it has writes, a <resource>_write tool (destructive).
// confirm: true  -> always requires confirm:true (money-moving / irreversible / deletes)
// confirm: "batchNotOpen" -> requires confirm when the target batch is not 'open'
// list: "<arrayKey>" -> supports all:true auto-pagination
export const RESOURCES = {
  recipients: {
    doc: "Recipients (R- ids). Returns RecipientSummary; sensitive fields are never returned.",
    read: {
      list:             { m: "GET", p: "/recipients", list: "recipients" },
      get:              { m: "GET", p: "/recipients/{recipientId}" },
      logs:             { m: "GET", p: "/recipients/{recipientId}/logs", list: "recipientLogs" },
      payments:         { m: "GET", p: "/recipients/{recipientId}/payments", list: "payments" },
      offline_payments: { m: "GET", p: "/recipients/{recipientId}/offlinePayments", list: "offlinePayments" },
    },
    write: {
      create:      { m: "POST",   p: "/recipients" },
      update:      { m: "PATCH",  p: "/recipients/{recipientId}" },
      delete:      { m: "DELETE", p: "/recipients/{recipientId}", confirm: true },
      delete_many: { m: "DELETE", p: "/recipients", confirm: true },
    },
  },
  recipient_accounts: {
    doc: "Recipient payout accounts (A- ids) under a recipient. Account numbers and bank details are never returned.",
    read:  { get: { m: "GET", p: "/recipients/{recipientId}/accounts/{accountId}" } },
    write: {
      create: { m: "POST",   p: "/recipients/{recipientId}/accounts" },
      update: { m: "PATCH",  p: "/recipients/{recipientId}/accounts/{accountId}" },
      delete: { m: "DELETE", p: "/recipients/{recipientId}/accounts/{accountId}", confirm: true },
    },
  },
  batches: {
    doc: "Batches (B- ids). start_processing SENDS MONEY and is irreversible.",
    read: {
      list:    { m: "GET", p: "/batches", list: "batches" },
      get:     { m: "GET", p: "/batches/{batchId}" },
      summary: { m: "GET", p: "/batches/{batchId}/summary" },
    },
    write: {
      create:           { m: "POST",   p: "/batches" },
      generate_quote:   { m: "POST",   p: "/batches/{batchId}/generate-quote" },
      start_processing: { m: "POST",   p: "/batches/{batchId}/start-processing", confirm: true, money: true },
      delete:           { m: "DELETE", p: "/batches/{batchId}", confirm: true },
      delete_many:      { m: "DELETE", p: "/batches", confirm: true },
    },
  },
  payments: {
    doc: "Payments (P- ids), always inside a batch. Normalized to Payout unless raw:true.",
    read: {
      list_in_batch: { m: "GET", p: "/batches/{batchId}/payments", list: "payments" },
      get:           { m: "GET", p: "/payments/{paymentId}" },
      get_in_batch:  { m: "GET", p: "/batches/{batchId}/payments/{paymentId}" },
    },
    write: {
      create: { m: "POST",   p: "/batches/{batchId}/payments", confirm: "batchNotOpen" },
      update: { m: "PATCH",  p: "/batches/{batchId}/payments/{paymentId}", confirm: "batchNotOpen" },
      delete: { m: "DELETE", p: "/batches/{batchId}/payments/{paymentId}", confirm: true },
    },
  },
  offline_payments: {
    doc: "Offline payments (OP- ids): records of payments made outside Trolley (no money moves).",
    read: {
      list:              { m: "GET", p: "/offline-payments", list: "offlinePayments" },
      list_for_recipient:{ m: "GET", p: "/recipients/{recipientId}/offlinePayments", list: "offlinePayments" },
    },
    write: {
      create: { m: "POST",   p: "/recipients/{recipientId}/offlinePayments" },
      update: { m: "PATCH",  p: "/recipients/{recipientId}/offlinePayments/{offlinePaymentId}" },
      delete: { m: "DELETE", p: "/recipients/{recipientId}/offlinePayments/{offlinePaymentId}", confirm: true },
    },
  },
  invoices: {
    doc: "Invoices (I- ids) and lines (IL- ids). Trolley uses POST for invoice get/search; these are still reads.",
    read: {
      get:    { m: "POST", p: "/invoices/get" },
      search: { m: "POST", p: "/invoices/search", list: "invoices", bodyPaging: true },
    },
    write: {
      create:       { m: "POST", p: "/invoices/create" },
      update:       { m: "POST", p: "/invoices/update" },
      delete:       { m: "POST", p: "/invoices/delete", confirm: true },
      create_lines: { m: "POST", p: "/invoices/create-lines" },
      update_lines: { m: "POST", p: "/invoices/update-lines" },
      delete_lines: { m: "POST", p: "/invoices/delete-lines", confirm: true },
    },
  },
  invoice_payments: {
    doc: "Invoice payments: link invoice lines to payments in a batch.",
    read:  { search: { m: "POST", p: "/invoices/payment/search", list: "invoicePayments", bodyPaging: true } },
    write: {
      create: { m: "POST", p: "/invoices/payment/create" },
      update: { m: "POST", p: "/invoices/payment/update" },
      delete: { m: "POST", p: "/invoices/payment/delete", confirm: true },
    },
  },
  balances: {
    doc: "Account balances and funding info.",
    read: {
      all:          { m: "GET", p: "/balances" },
      paymentrails: { m: "GET", p: "/balances/paymentrails" },
      paypal:       { m: "GET", p: "/balances/paypal" },
      funding_info: { m: "GET", p: "/balances/info" },
    },
  },
  verifications: {
    doc: "Trust: watchlist / identity / business verifications.",
    read:  { list: { m: "GET", p: "/verifications", list: "verifications" } },
    write: {
      trigger_watchlist: { m: "POST",  p: "/verifications/watchlist/trigger", confirm: true },
      trigger:           { m: "POST",  p: "/verifications/trigger", confirm: true },
      expire:            { m: "PATCH", p: "/verifications/expire", confirm: true },
    },
  },
  webhooks: {
    doc: "Webhook subscriptions (SS- ids). Subscription hmac secrets are never returned.",
    read: {
      list: { m: "GET", p: "/subscriptions" },
      get:  { m: "GET", p: "/subscriptions/{subscriptionId}" },
    },
    write: {
      create:    { m: "POST",   p: "/subscriptions" },
      update:    { m: "PATCH",  p: "/subscriptions/{subscriptionId}" },
      delete:    { m: "DELETE", p: "/subscriptions/{subscriptionId}", confirm: true },
      retrigger: { m: "POST",   p: "/subscriptions/test" },
    },
  },
  reference: {
    doc: "Reference data.",
    read: { country: { m: "GET", p: "/geography/countries/{countryCode}" } },
  },
  partner: {
    doc: "Partner/platform-account endpoints (fees, payout methods, settings, white-label, sub-merchants, sandbox profile). All partner writes change account-wide settings and need confirm. Usually need a partner-enabled account.",
    read: {
      fees:                { m: "GET",  p: "/fees" },
      route_pricing:       { m: "POST", p: "/fees/route-pricing/search" },
      widget_config:       { m: "GET",  p: "/iframe/config" },
      payout_methods:      { m: "GET",  p: "/payout-methods" },
      payout_method:       { m: "GET",  p: "/payout-methods/{payoutMethod}" },
      processing_settings: { m: "GET",  p: "/processing-settings" },
      white_label:         { m: "GET",  p: "/white-label" },
      white_label_dns:     { m: "GET",  p: "/white-label/dns-records" },
    },
    write: {
      update_fee_cover:         { m: "PATCH",  p: "/fees", confirm: true },
      create_revenue_stream:    { m: "POST",   p: "/fees/revenue-stream/create", confirm: true },
      update_revenue_stream:    { m: "POST",   p: "/fees/revenue-stream/update", confirm: true },
      update_widget_config:     { m: "POST",   p: "/iframe/config", confirm: true },
      update_onboarding:        { m: "POST",   p: "/onboarding/update", confirm: true },
      update_payout_method:     { m: "PATCH",  p: "/payout-methods/{payoutMethod}", confirm: true },
      update_processing_settings:{ m: "PATCH", p: "/processing-settings", confirm: true },
      create_sandbox_profile:   { m: "POST",   p: "/profile/sandbox", confirm: true },
      delete_sandbox_profile:   { m: "DELETE", p: "/profile/sandbox", confirm: true },
      create_submerchant:       { m: "POST",   p: "/profile/submerchant", confirm: true },
      update_white_label:       { m: "PATCH",  p: "/white-label", confirm: true },
      verify_white_label_dns:   { m: "POST",   p: "/white-label/dns-records/verify", confirm: true },
      delete_white_label_email: { m: "DELETE", p: "/white-label/email", confirm: true },
      update_white_label_icon:  { m: "PATCH",  p: "/white-label/icon", confirm: true },
    },
  },
};
export const ID_ARGS = { recipientId: "R", accountId: "A", batchId: "B", paymentId: "P", offlinePaymentId: "OP", subscriptionId: "SS", countryCode: null, payoutMethod: null };
