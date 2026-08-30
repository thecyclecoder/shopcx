# inngest/review-candidacy-detector-cron

Cron that finds tickets quiet for 24h since the LAST EXTERNAL message (and we spoke last) and enqueues one `review-candidacy` box job per qualifying ticket for Sol's read-only review-candidacy pass. Phase 1 of the review-request-sol-session program.

**File:** `src/lib/inngest/review-candidacy-detector-cron.ts`

**Spec folded:** [[../specs/review-candidacy-detector-lane-backpressure-and-completed-de]] — Phase 1 bounded detector output to REVIEW_CANDIDACY_ENQUEUE_CAP=5 per tick (was 50) and added a 14-day cooldown lookup so tickets already assigned a verdict are not reconsidered on the next cron tick.

## Functions

### `review-candidacy-detector-cron`
- **Trigger:** cron `*/30 * * * *` (every 30 min) — NOT an Inngest event
- **Retries:** 1 · **Concurrency:** 1

Two passes per tick:

1. **`enqueue-review-candidacy-jobs`** — read the eligible ticket set + apply the pure predicate + enqueue one `agent_jobs` row per surviving ticket (kind=`review-candidacy`, `spec_slug=<ticket_id>` for per-ticket dedup identical to `ticket-analyze` / `cs-director-call`).
   - **SQL prefilter:** `tickets` with `customer_id IS NOT NULL`, `status != 'archived'`, `updated_at` between `now - 7d` and `now - 24h` (batched at `REVIEW_CANDIDACY_READ_PREFILTER = 150` — kept wide so a tick with many ineligible rows still surfaces enough fresh candidates to fill the cap).
   - **Per-ticket last-external-message read:** `ticket_messages` for the fetched ids where `visibility != 'internal'`, most recent 3 per ticket. The pure predicate `passesReviewCandidacyWindow` filters candidates to those whose latest EXTERNAL message is (a) outbound (we spoke last — the 3.5% "customer had the last word" tickets are excluded), (b) ≥ 24h old, and (c) whose ticket age is ≤ 7d.
   - **Dedupe against recent asks:** any customer with a `review_requests` row within the last 24h is skipped — a coarse "one ask per customer per short window" guard the ladder Phase 2 will refine.
   - **Dedupe against inflight jobs:** any `agent_jobs` with `kind='review-candidacy'` + matching `spec_slug` in `queued|queued_resume|claimed|building|needs_input` is skipped.
   - **Dedupe against recent verdicts (cooldown):** any `agent_jobs` with `kind='review-candidacy'` + matching `spec_slug` in `completed|failed|needs_attention` inside the last `REVIEW_CANDIDACY_VERDICT_COOLDOWN_HOURS` (2× MAX_AGE_DAYS = 14d) is skipped and counted in `skipped_recent_verdict`. Phase 1 does not persist a `review_requests` ledger row for Sol's verdict, so the `agent_jobs` row IS the fingerprint the next tick must respect — before this filter a quiet outbound ticket was reconsidered every 30 min for its remaining 7-day eligibility.
   - **Cap:** at most `REVIEW_CANDIDACY_ENQUEUE_CAP = 5` enqueues per tick — bounded to the concurrency-1 Sol lane's throughput; the remainder reports as `deferred` and picks up on the next tick. The pure `selectReviewCandidacyBatch` helper composes the four dedupe passes + cap slice and is covered by `review-candidacy-detector-cron.selection.test.ts`.
2. **`emit-heartbeat`** — `emitCronHeartbeat("review-candidacy-detector-cron", { ok:true, produced:{ eligible, enqueued, deferred, skipped_recent_verdict } })` — every tick (idle or not) so the CT watchdog sees a beat. `skipped_recent_verdict` distinguishes "detector suppressed a repeat" from "detector silently did nothing".

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

## Eligibility: both sides must have spoken

A ticket only reaches Sol if it carries **both** an external inbound (the customer wrote) and an external outbound (we answered). Checked with two direction-scoped reads rather than the 3-most-recent-per-ticket window used for `latestExternal`, which could miss an inbound sitting behind three recent outbounds.

**Why:** `latestExternal` answers *who spoke last*, and a one-sided automated ticket passes that trivially — it has an outbound and nothing else. Live evidence: an automated dunning ticket burned a full Sol session, and her own verdict read *"with AI turns=0 she hasn't even responded, so there is no finished conversation."* Measured across the first 79 sessions, **23 (29%) were one-sided** — pure waste in a lane that runs one session at a time.

Deliberately a general rule, not a `dunning` tag match: it also excludes auto-replies, shipping notices, OOF bounces, and whatever one-sided ticket type nobody has thought of yet. Same class as the CSAT cron's "only survey tickets we actually answered" guard ([[../lifecycles/csat]] § 3a), applied to both directions instead of one.

Counted separately as `skipped_one_sided` in the heartbeat, and evaluated **before** the verdict-cooldown check so the two counters never double-attribute the same ticket.

## Coverage is a tiebreaker, not a veto

Sol's brief ranks candidate products by review coverage so a thin product wins over a thick one. That is a **tiebreaker between two eligible products only**.

The first 117 sessions produced **zero asks**, and **52 of the declines (44%)** cited coverage as a disqualifier — nearly all Superfood Tabs, the flagship and the only product most customers ever buy. The skill had listed "the coverage tilts the wrong way" among the reasons to skip, alongside "skipping is ALWAYS correct", so a tiebreaker meant for the rare multi-product case was vetoing the largest cohort. Corrected in `.claude/skills/review-candidacy/SKILL.md`.

Second-order point worth keeping: Superfood Tabs' ~3,158 reviews are **all frozen Klaviyo-era rows predating 2026-07-01**. Lifetime totals are the wrong measure of coverage when nothing has been collected in months — a PDP needs recency and the ad tool mines current verbatims. A product with no recent reviews is UNDER-covered regardless of its total.
