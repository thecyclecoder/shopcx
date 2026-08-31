# libraries/review-request-delivery

Review-request delivery SDK — the shared plumbing behind Phase 3 of [[../specs/review-request-sol-session]].

**File:** `src/lib/review-request-delivery.ts`

The Phase-2 rubric + validator + drafts persistence sits upstream of the customer send. Phase 3 is what actually ships the ask — one journey per ask (a double-click cannot double-issue a coupon), one nudge if the customer doesn't respond, one canary hold that goes through the existing [[../inngest/deliver-pending-send]] outbox so the ticket UI's "Sending at {time} · Cancel" behaviour applies for free.

## Exports

| Export | Kind | Purpose |
|---|---|---|
| `ReviewRequestChannel` | type | `'email' \| 'sms'` |
| `ReviewRequestAngle` | type | `'defend' \| 'fence-sitter'` |
| `ReviewRequestOutcome` | type | Union of the 5 pinned outcomes. |
| `REVIEW_REQUEST_OUTCOMES` | const | `['sent','clicked','submitted','routed_to_cs','expired']` |
| `REVIEW_REQUEST_NUDGE_DELAY_MS` | const | `3 * 24h` — spec: 3-4 days after the first-touch. |
| `REVIEW_REQUEST_CANARY_HOLD_MS` | const | `18h` — inside the spec's 12-24h range. |
| `mintReviewRequestToken()` | function | PURE — 24-hex per-ask token; shared across channels. |
| `pickReviewRequestChannel(input)` | function | PURE — SMS if opted-in, else email if not unsubscribed, else null (skip). |
| `shouldSuppressReviewRequestNudge(input)` | function | PURE — the spec's suppression list encoded verbatim. |
| `isReviewRequestReadyForNudge(input)` | function | PURE — inside the 3-day window? |
| `insertReviewRequestRow(admin, input)` | async | Live — one `review_requests` row per ask. |
| `queueReviewRequestAsPendingTicketMessage(admin, input)` | async | Live — canary-hold outbound as `ticket_messages.pending_send_at` (default hold: 18h). |
| `markReviewRequestNudgeFired(admin, reviewRequestId)` | async | Live — compare-and-set `nudged_at` (returns false on lost race; caller MUST short-circuit). |

## Design

Two halves — pure predicates + token mint + channel pick are unit-tested in isolation (`src/lib/review-request-delivery.test.ts`); the DB helpers are thin wrappers around single-row Supabase calls with named-error throws.

Every nudge suppression has a stable reason string a caller logs verbatim:

| reason | condition |
|---|---|
| `already_nudged` | `nudged_at` is not null. |
| `outcome_submitted` | The customer already reviewed. |
| `outcome_routed_to_cs` | 1-3 star review opened a CS ticket. |
| `outcome_expired` | The window closed. |
| `outcome_clicked` | The customer opened the link. |
| `customer_replied` | Paragraph reply after the first-touch. |
| `customer_unsubscribed` | Unsubscribed since the ask went out. |

## Callers

- **[[../inngest/review-request-nudge-cron]]** — the 30-min sweep that finds review_requests ready for the follow-up. Uses `isReviewRequestReadyForNudge`, `shouldSuppressReviewRequestNudge`, `markReviewRequestNudgeFired`, `queueReviewRequestAsPendingTicketMessage`.
- **Phase-3 send path** (in Sol's compose stage) — uses `pickReviewRequestChannel`, `mintReviewRequestToken`, `insertReviewRequestRow`, `queueReviewRequestAsPendingTicketMessage`. The 18h canary hold means [[review-request-canary-digest-cron]] can raise a digest before the outbox fires.
- **[[journey-definition-probe]]** `assertProductReviewJourneyActive` is called BEFORE any of the above — a missing/inactive journey_definitions row short-circuits to skip, so a workspace whose seed silently missed doesn't burn goodwill on a link that resolves to a 404.

## Related

- [[../tables/review_requests]] — the ask table.
- [[../tables/review_message_drafts]] — where the composed message + validator verdict lands (Phase 2).
- [[review-request-validator]] — the deterministic pre-send validator every drafted message routes through.
- [[../inngest/deliver-pending-send]] — the 5-min outbox that ships queued messages.

---

[[../README]] · [[../../CLAUDE]]
