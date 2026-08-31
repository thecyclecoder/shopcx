# libraries/cs-director-cancellation-timeline

Per-contract cancellation timeline for the CS Director's brief. Merges each subscription's `cancelled_at` (from [[../tables/subscriptions]]) with the sub's [[../tables/billing_forecast_events]] rows and the sub's orders into ONE chronological sequence so charge-vs-cancel ordering is readable in a glance instead of requiring a join in June's head.

**File:** `src/lib/cs-director-cancellation-timeline.ts`

## Why this exists

Ticket f773b8ec (bonnie marlette, 2026-08-21) is the ground truth. Contract 27806990509 cancelled at 2026-07-17T08:39:51, thirty-six minutes AFTER the last renewal billed at 2026-07-17T08:03:45. All three of Bonnie's charges (2026-04-01, 2026-05-28, 2026-07-17) were ordinary pre-cancel renewals, all three orders were delivered and kept, nothing had billed in the five weeks since — but the CS Director escalated to the founder claiming "contract 27806990509 is alive in Appstle and has billed three post-cancellation renewals — $69.71 × 3 = $209.13 is fully refundable." The cancel moment lived in `billing_forecast_events` the whole time and was never surfaced. An order landing after a cancel is near-impossible by construction, so the claim was structurally implausible — but June could not do the cheapest possible check because she had no cancel timestamp in front of her.

The [[cs-director]] brief is the defect, not June's reasoning. Fixed by [[../specs/cs-director-must-timestamp-a-cancelled-but-charged-claim]] Phase 1 (this library) + Phase 2 (the mandatory ordering-check rule in `.claude/skills/cs-director-call/SKILL.md`).

## Exports

- **`buildCancellationTimeline(input)`** — pure function. `input` is `{ subscriptions, events, orders, eventCap? }` (arrays the caller pre-loaded). Returns one `SubscriptionCancellationTimeline` per subscription — `{ subscription_id, shopify_contract_id, cancelled_at, rows: TimelineRow[], truncated, post_cancellation_charges }`. Filters events by matching `shopify_contract_id` and orders by either `subscription_id === sub.id` OR matching `shopify_contract_id`. Sorts chronologically. Caps at the most-recent 20 rows per contract and marks `truncated:true` when the cap fires (no silent caps).
- **`formatCancellationTimelineForBrief(timelines)`** — renderer. Emits the block June's prompt reads, with a `CANCELLED` marker on the cancel row and `→ CHARGE` on charge rows so the ordering pops.
- **`CANCELLATION_TIMELINE_EVENT_CAP`** — the 20-row cap, exported so tests + brain pin the same constant.

## `event_type` literals

Probed against the shape verified on contract 27806990509 (via `src/lib/billing-forecast.ts` `logForecastEvent` sites): `billing_success`, `new_subscription`, `cancellation`, `billing_failure`, `pause`, `date_change_out`, `date_change_in`, `item_change`. The library treats `cancellation` as the cancel marker and `billing_success` (or an order row) as the "charge" for `post_cancellation_charges`.

## Callers

- `scripts/builder-worker.ts` `loadCsDirectorCallBrief` — loads the customer's subs + `billing_forecast_events` rows for those contracts + orders, calls `buildCancellationTimeline`, and pushes `formatCancellationTimelineForBrief`'s output plus the Phase-2 mandatory-ordering-check sentence into the brief.

## Regression test

`src/lib/cs-director-cancellation-timeline.test.ts` — pinned by the spec's verification. Registered as the pinned npm script `test:cs-director-cancellation-timeline`. Asserts Bonnie's ordering specifically: given the 08:03:45 charge and the 08:39:51 cancellation on the same day, the emitted timeline places the cancellation AFTER the charge and reports zero post-cancellation charges. Additional cases: a genuine post-cancel charge IS counted, the cap truncates and flags, a never-cancelled sub renders cleanly, and the brief formatter surfaces the `CANCELLED` marker plus the post-cancel count.

## Gotchas

- **Pure function, no I/O.** The caller pre-loads the three arrays; a DB import here would make it un-unit-testable and would drag the box worker's DB coupling into a library that has no reason to know about the pooler.
- **`shopify_contract_id` is a Shopify boundary field.** The library filters events by matching contract id because that is the join key `billing_forecast_events` uses. Never introduce an internal-only shape here without updating [[subscriptions]] first — see [[../CLAUDE.md]] § Internal joins use UUIDs.
- **Cap counts most-recent rows.** When `rows.length > CANCELLATION_TIMELINE_EVENT_CAP`, the library keeps the last N and sets `truncated:true`. A brief that hides older activity but does not say so would let the same claim resurface — same class as "no silent caps".

---

[[../README]] · [[cs-director]] · [[../tables/billing_forecast_events]] · [[../tables/subscriptions]]
