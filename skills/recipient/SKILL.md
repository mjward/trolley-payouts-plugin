---
name: recipient
description: Look up a single Trolley recipient from a pasted recipient ID (R-…), reference ID or email address and show a short, non-sensitive summary. Use when the user types /recipient or pastes a Trolley recipient ID, reference ID or email and asks who it is or what state it's in.
---

Accepts a recipient ID (`R-…`), an email (anything containing `@`), a reference ID (UUID, matched exactly), or any other text as a **search** (a prefix match on name, email user or domain, and referenceId; searching by a person's name is fine). Pass the input as pasted to `recipient_lookup` and say which route matched (`matchedBy`). For a search with several hits, list the candidates (ID, email, status) and the total `count`.

**Never show a recipient's name.** Names are sensitive and the tool doesn't return them. Show the recipient ID, email, referenceId and statuses.

# /recipient (read-only)

1. Take the user's pasted text as-is and call `recipient_lookup` with `query` set to it. The tool strips whitespace, `mailto:`, `<…>` and quotes.
2. Show the result as a short summary: email, ID, referenceId, status, complianceStatus, payoutMethod, country, isPhoneVerified, createdAt, and whether it matched by `id`, `email` or `referenceId`.
3. If the tool returns not-found or ambiguous, say so plainly. Suggest the other identifier (ID vs email) or the other environment (sandbox vs live), since each environment uses its own keys.

Rules:
- Read-only. Never call write tools from this skill.
- Never request or display sensitive data (SSN/government IDs, DOB, passport, address, bank or account numbers, tax details, phone numbers). The tool never returns them; don't ask for them.
- Don't invent fields. Report only what the tool returns, and show null values as "not set".
- For payments to this recipient, use `recipients_read {action:"payments", recipientId}` and only if the user asks.

- Show statuses as an emoji dot plus inline code (e.g. `Status: 🟡 `incomplete``). Use `statusBadge` / `complianceBadge` when present. 🟢 active/processed/completed, 🟡 incomplete/pending/open/awaiting approval, 🔴 blocked/failed/returned/suspended, ⚪ anything else.
- Every result has an `environment` field (sandbox | production | unknown). Call `whoami` if unsure, and state the environment when it matters.

## Rendering
Use plain lines, one per field, with no tables: ID, Reference ID, Email, Status, Compliance, Payout method, Country, Phone verified, Created. Write status fields as `Status: 🟢 `active`` and `Compliance: 🟡 `pending``: the label, a colon, then the `statusBadge` / `complianceBadge` string (an emoji dot plus inline code), on one line. No images or tables.
