# inngest/review-request-nudge-cron

Cron that fires exactly ONE nudge per review-request ask, 3-4 days after the first-touch, if the customer hasn't responded. Phase 3 of [[../specs/review-request-sol-session]].

**File:** `src/lib/inngest/review-request-nudge-cron.ts`

## Functions

### `review-request-nudge-cron`
- **Trigger:** cron `*/30 * * * *` (every 30 min) — NOT an Inngest event
- **Retries:** 1 · **Concurrency:** 1

Two passes per tick:

1. **`enqueue-nudges`** — sweep `review_requests` where `nudged_at IS NULL`, `outcome='sent'`, and `sent_at` is between 14 days ago (ceiling) and 3 days ago (ready). For each candidate:
   - Re-run the pure predicate `isReviewRequestReadyForNudge` (belt-and-braces on the SQL prefilter).
   - Re-run the pure predicate `shouldSuppressReviewRequestNudge` — suppression reasons include `already_nudged` / `outcome_submitted` / `outcome_routed_to_cs` / `outcome_expired` / `outcome_clicked` / `customer_replied` / `customer_unsubscribed`.
   - Resolve the anchoring ticket (most-recent per customer). A row without a matching ticket is a suppress (the nudge shape requires a thread to reply into).
   - Check `ticket_messages.direction='inbound'` since `sent_at`; a paragraph reply is a hard suppress.
   - Compare-and-set `review_requests.nudged_at = now()` via `markReviewRequestNudgeFired` — a lost race means another tick claimed the row; short-circuit.
   - Resolve the product title, compose the 3-line nudge body via `composeReviewRequestNudgeBody`, and queue as a pending ticket message via `queueReviewRequestAsPendingTicketMessage` with `holdMs=0` (no canary hold on the nudge; the CANARY guard was the first-touch's job).

2. **`emit-heartbeat`** — `emitCronHeartbeat("review-request-nudge-cron", { ok:true, produced:{ eligible, nudged, suppressed } })` — every tick (idle or not).

**Kill switch (CLAUDE.md hard rule — supervisable autonomy):** `enforceSwitch("review-request-nudge-cron")` is the **first body statement**. A blocked cascade writes a `blocked_off` heartbeat via the resolver and returns immediately; the CT tile renders AMBER `off by <ancestor>` instead of RED "no beats".

**Cadence + liveness** — `expectedCadence: "every 30 min (*/30 * * * *)"`, `livenessWindowMs: 45 min` (≥ 1.2× the 30m cadence per `assertRegistryInvariants`). `registeredAt: "2026-08-28T00:00:00Z"` graces the first-tick window.

**Nudge channel** — always email (a second modality; no second TCPA-exposed SMS per the spec). The composed body is a REPLY in the same thread (`Re:` subject via the deliver-pending-sends outbox's existing plumbing), 3 lines, re-raising the SAME question with the time cost stated.

## Downstream events sent

_None._ The nudge is inserted into `ticket_messages.pending_send_at`; the [[deliver-pending-send]] cron drains it on its 5-min tick (with the newer-inbound guard the outbox already has, so a mid-flight reply auto-cancels).

## Related

- **Delivery SDK** — [[../libraries/review-request-delivery]] — the pure predicates (`shouldSuppressReviewRequestNudge`, `isReviewRequestReadyForNudge`) + the compare-and-set write (`markReviewRequestNudgeFired`) + the pending-send helper.
- **Ladger** — [[../tables/review_requests]] — the ask row + its `nudged_at` compare-and-set target.
- **Outbox** — [[deliver-pending-send]] — the 5-min cron that ships the queued nudge.
- **Detector** — [[review-candidacy-detector-cron]] — Phase 1's cron that seeds the first-touch this cron follows up on.

---

[[../README]] · [[../../CLAUDE]] · [[../tables/review_requests]] · [[review-request-canary-digest-cron]]
