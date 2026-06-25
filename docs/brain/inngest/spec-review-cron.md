# inngest/spec-review-cron

The **periodic enqueuer** for the box-hosted **spec-review agent** ([[../specs/spec-review-agent]]). Every newly authored spec lands in the `in_review` column — BEFORE `planned` — and the build dispatch is hard-stopped behind it. This cron is the trigger that drains the queue: whenever ≥1 spec is parked in `in_review` (per workspace), it inserts one `agent_jobs` row `kind='spec-review'` so the box's spec-review lane (`scripts/builder-worker.ts → runSpecReviewJob`) picks it up and reviews every in-review spec on Max.

Same enqueue-only shape as [[spec-test-cron]] / [[triage-escalations]] — the box has no internal ticker, so an Inngest cron is the trigger. **This cron does NO reasoning** — purely the enqueue. The box keeps its secrets so the agent can read the prod DB; the WORKER is the only component that mutates state.

**File:** `src/lib/inngest/spec-review-cron.ts` (registered in `src/lib/inngest/registered-functions.ts`)

## Functions

### `spec-review-cron`
- **Trigger:** cron `*/15 * * * *` (every 15 minutes — the build pipeline is gated behind the in_review column, so the backlog can't sit long)
- **Retries:** 1
- **Concurrency:** `concurrency: [{ limit: 1 }]`

## What it enqueues

For each build-console workspace (any workspace with an [[../tables/agent_jobs]] row), the cron calls `enqueueSpecReviewIfDue(workspaceId)` ([[../libraries/agents-spec-review]]). That helper checks `spec_card_state` for rows with `status='in_review'` (the `effectiveStatusFromState` rollup honors `flags.deferred`, so a deferred row never slips into the pool). If there's ≥1 in_review spec AND no in-flight `spec-review` job for the workspace, it inserts a single `queued` `agent_jobs` row `kind='spec-review'` (`spec_slug='spec-review-sweep'`, a sentinel — Vale sweeps the queue, not one spec).

## Dedupe

The cron does **not** dedupe itself — it delegates to `enqueueSpecReviewIfDue` (one-in-flight guard: skip when the workspace already has a `spec-review` job in `queued | queued_resume | building | claimed`). A cron tick that races an event-driven enqueue (future) no-ops cleanly.

## Downstream events sent

_None._ The box polls [[../tables/agent_jobs]] and claims the row; there is no HTTP call into the box (it only reaches out — [[../recipes/build-box-setup]]).

## Tables written

- [[../tables/agent_jobs]] (inserts the `spec-review` job; one per workspace per cadence when due)
- `loop_heartbeats` (the cron's end-of-run heartbeat)

## Tables read (not written)

- [[../tables/agent_jobs]] (workspace discovery + in-flight dedupe)
- `spec_card_state` (the `in_review` queue per workspace)

## Contrast with `spec-test-cron`

Same enqueue-only shape, but **shorter cadence** (15 min vs daily) because spec-review is upstream of `planned` — every minute a sound spec sits in_review is throughput the build pipeline can't claim. The spec-test cron is downstream of `shipped`, so its cadence can be slack.

---

[[../README]] · [[../integrations/inngest]] · [[../libraries/agents-spec-review]] · [[../tables/agent_jobs]] · [[../recipes/build-box-setup]] · [[../specs/spec-review-agent]] · [[../project-management]]
