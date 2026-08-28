# inngest/review-candidacy-detector-cron

Cron that finds tickets quiet for 24h since the LAST EXTERNAL message (and we spoke last) and enqueues one `review-candidacy` box job per qualifying ticket for Sol's read-only review-candidacy pass. Phase 1 of the review-request-sol-session program.

**File:** `src/lib/inngest/review-candidacy-detector-cron.ts`

## Functions

### `review-candidacy-detector-cron`
- **Trigger:** cron `*/30 * * * *` (every 30 min) — NOT an Inngest event
- **Retries:** 1 · **Concurrency:** 1

Two passes per tick:

1. **`enqueue-review-candidacy-jobs`** — read the eligible ticket set + apply the pure predicate + enqueue one `agent_jobs` row per surviving ticket (kind=`review-candidacy`, `spec_slug=<ticket_id>` for per-ticket dedup identical to `ticket-analyze` / `cs-director-call`).
   - **SQL prefilter:** `tickets` with `customer_id IS NOT NULL`, `status != 'archived'`, `updated_at` between `now - 7d` and `now - 24h` (batched at 150).
   - **Per-ticket last-external-message read:** `ticket_messages` for the fetched ids where `visibility != 'internal'`, most recent 3 per ticket. The pure predicate `passesReviewCandidacyWindow` filters candidates to those whose latest EXTERNAL message is (a) outbound (we spoke last — the 3.5% "customer had the last word" tickets are excluded), (b) ≥ 24h old, and (c) whose ticket age is ≤ 7d.
   - **Dedupe against recent asks:** any customer with a `review_requests` row within the last 24h is skipped — a coarse "one ask per customer per short window" guard the ladder Phase 2 will refine.
   - **Dedupe against inflight jobs:** any `agent_jobs` with `kind='review-candidacy'` + matching `spec_slug` in `queued|queued_resume|claimed|building|needs_input` is skipped.
   - **Cap:** at most 50 enqueues per tick; the remainder deferrs to the next tick.
2. **`emit-heartbeat`** — `emitCronHeartbeat("review-candidacy-detector-cron", { ok:true, produced:{ eligible, enqueued, deferred } })` — every tick (idle or not) so the CT watchdog sees a beat.

**Kill switch (CLAUDE.md hard rule — supervisable autonomy):** `enforceSwitch("review-candidacy-detector-cron")` is the **first body statement**. A blocked cascade writes a `blocked_off` heartbeat via the resolver and returns immediately; the CT tile renders AMBER `off by <ancestor>` instead of RED "no beats". Same shape [[shopify-review-metafields-sync]] uses.

**Ordering vs the CSAT ask** — CSAT fires at 48h ([[ticket-csat]]); this fires at 24h. The review ask lands one day before the CSAT ask; no change to the CSAT cron is needed.

**Cadence + liveness** — pinned in [[../libraries/control-tower]] `registry.ts`: `expectedCadence: "every 30 min (*/30 * * * *)"`, `livenessWindowMs: 45 min` (≥ 1.2× the 30m cadence per `assertRegistryInvariants`; matches the CSAT cron's 45-min window shape). `registeredAt: "2026-08-28T00:00:00Z"` graces the first-tick window (newcron-grace).

## Downstream events sent

_None._ The cron writes directly to `agent_jobs`; the box worker's `review-candidacy` lane drains it and runs Sol's session.

## Related

- **Box worker lane** — [[../libraries/builder-worker]] `runReviewCandidacyJob`: a top-level Max `claude -p` (review-candidacy skill) that reads the same base brief `runTicketHandleJob` builds and emits ONE JSON verdict `{ ask, product_id, angle, include_coupon, reasoning }`. Sol NEVER sends; the WORKER is the only mutator.
- **Ladger** — [[../tables/review_requests]] carries the ask's memory once Phase 2 + Phase 3 mint rows. Phase 1's cron ONLY enqueues Sol's read-only session; the ladder writes land in later phases.
- **Node registry** — [[../libraries/control-tower-node-registry]]: owner `cs` (Sol reports to June); both the cron and the `agent:review-candidacy` box lane appear as MONITORED_LOOPS rows, and `review-candidacy` is registered in `BUILDER_WORKER_KINDS` so `resolveNodeOwner` never sees an orphan.

---

[[../README]] · [[../../CLAUDE]] · [[../tables/review_requests]] · [[ticket-csat]]
