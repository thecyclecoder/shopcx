# libraries/review-request-validator

The deterministic pre-send validator for a drafted review-request message (Phase 2 of [[../specs/review-request-sol-session]]).

**File:** `src/lib/review-request-validator.ts`

A drafted message CANNOT send if ANY of the hard rules trip. The whole program's value is in the message; the failure that would actually kill it is not mediocre prose but a broken merge field telling a two-year customer they have been with us for 0 days. This validator is the absolute half — things that can never be wrong, checked by code, no LLM taste involved. A BLOCK verdict short-circuits the send AND is persisted to [[../tables/review_message_drafts]].`validator_verdict` for provenance.

## Exports

| Export | Kind | Purpose |
|---|---|---|
| `ReviewRequestChannel` | type | `'email' \| 'sms'` |
| `APPROVED_REVIEW_PRETEXTS` | const | `['defend', 'fence-sitter']` — the pinned angle set. |
| `ReviewRequestPretext` | type | Union of the pinned angles. |
| `ReviewRequestDraft` | interface | The drafted message + context bag the validator reads. |
| `ReviewRequestValidationVerdict` | interface | `{ allow, reasons }` — the block/allow result. |
| `validateReviewRequest(draft)` | function | PURE — the validator. Never throws; returns a verdict. |

## Hard rails (reason strings)

Every reason string in the verdict names the specific rail that tripped. The names below are the exact strings a caller looks for; the persisted verdict on [[../tables/review_message_drafts]].`validator_verdict.reasons` carries the same strings.

| Reason | When |
|---|---|
| `empty_body` | Whitespace-only body. |
| `unfilled_mustache_in_body` | An unfilled `{{ ... }}` merge token survived into the body. |
| `unfilled_mustache_in_subject` | An unfilled `{{ ... }}` merge token survived into the subject line. |
| `more_than_one_ask` | Body carries more than one literal `?` — a stacked ask. |
| `tenure_degenerate_zero_days` | `tenureDays === 0` (broken merge / no tenure). |
| `loyalty_claim_on_first_order` | The body claims tenure ("loyal customer" / "long-time" / "years with us" / "veteran") but `orderCount ≤ 1`. |
| `wrong_product_named` | `productName` set, but the body names a different `otherProductNames` entry AND does NOT name `productName`. |
| `unapproved_pretext` | `angle` provided but not in `APPROVED_REVIEW_PRETEXTS`. |
| `sentiment_conditional_coupon_framing` | `coupon.include=true` and `coupon.framing` matches a sentiment-conditional pattern (e.g. "positive review", "5-star"). |
| `sentiment_conditional_coupon_body` | `coupon.include=true` and the BODY matches a sentiment-conditional pattern. |
| `sms_body_over_160_chars` | Channel `sms` and composed length (body + shortlink) > 160. |
| `sms_missing_stop_word` | Channel `sms` and body carries no STOP-word marker. |

## Design

Pure function of its input — no I/O, no timers, safe for `node:test`. Every rail is independent; a draft can trip multiple at once and every one lands in the `reasons` array. The invariant is unit-tested rail-by-rail in `src/lib/review-request-validator.test.ts`.

Optional context fields (`tenureDays`, `orderCount`, `angle`, `productName`, `otherProductNames`, `coupon`, `smsShortlink`) mean a Phase-1 minimal-shape caller still compiles — a missing field skips ONLY the rail that needs it (a conservative default). The Phase-3 send path passes the full bag so every rail runs.

## Callers

- Sol's compose session's downstream worker step calls `validateReviewRequest` on every drafted message BEFORE handing it to [[../inngest/deliver-pending-send]]. A BLOCK short-circuits the send; the verdict lands in [[review-message-drafts]] `validator_verdict`.
- The independent-QC session ALSO reads the validator's verdict as part of its own review (a validator-blocked draft is never QC'd — the block is terminal).

## Related

- [[../tables/review_message_drafts]].`validator_verdict` — where the verdict persists.
- [[review-message-rubric]] — the rubric-based half of the message check (LLM taste; this validator is the deterministic half).
- [[review-message-drafts]] — the persister that lands the verdict on the drafts table.
- [[../specs/review-request-sol-session]] — the spec.

---

[[../README]] · [[../../CLAUDE]]
