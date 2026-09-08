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
| `createReviewJourneySession(admin, input)` | async | Live — mints the `journey_sessions` row the magic link resolves against. **This is what makes a link work.** |
| `insertReviewRequestRow(admin, input)` | async | Live — mints the session FIRST, then writes one `review_requests` row joined to it via `journey_session_id`. |
| `queueReviewRequestAsPendingTicketMessage(admin, input)` | async | Live — canary-hold outbound as `ticket_messages.pending_send_at` (default hold: 18h). |
| `markReviewRequestNudgeFired(admin, reviewRequestId)` | async | Live — compare-and-set `nudged_at` (returns false on lost race; caller MUST short-circuit). |

## ⚠️ The link is only as real as its session (2026-09-08 dead-link outage)

`insertReviewRequestRow` used to REQUIRE a token (it threw without one) and then never persist it —
no `journey_sessions` row, no column on `review_requests`. The token existed only inside the sent
message body. So every minted `/review/{token}` link resolved to [[review-journey-core]]
`loadReviewSessionByToken` → `journey_sessions.token = …` → **no row** → 404 `session_not_found`.

**455 asks and 341 nudges all pointed at a dead page.** The response rate was 0.00% — not low, dead.
A real token was byte-for-byte as useful as a junk one.

Three things kept it invisible:

1. **The code said it did this.** Comments described the session as materializing "on first click",
   but nothing implemented that and the loader is a plain `SELECT`.
2. **The page 200s for junk.** `/review/[token]` is a client shell; it renders fine and only fails
   when it calls `/api/review/{token}`. A smoke test on the page URL passes.
3. **The tests only covered the pure half** — token shape, channel pick, nudge suppression. Nothing
   asserted the token a customer receives can actually be resolved.

The invariant now pinned in `review-request-delivery.session.test.ts`: **an ask MUST leave behind a
session keyed on the SAME token that goes into the link**, and if the session cannot be created the
ask ABORTS — no `review_requests` row is written. A row claiming `outcome='sent'` behind a 404 link
is worse than no row at all.

Recovery: `scripts/_backfill-review-journey-sessions.ts` revived 449 of 455 already-sent links
(98.7%) by parsing tokens out of message bodies and matching them back to their ask by
(customer, send-time) — the two rows are written within 0.1s of each other — with the product name
in the body breaking same-instant ties. Ambiguous matches are skipped, never guessed: a session
pointing at the wrong product asks someone to review something they did not buy.

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
