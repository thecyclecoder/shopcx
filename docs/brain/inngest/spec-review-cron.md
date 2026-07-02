# inngest/spec-review-cron

The **periodic enqueuer** for the box-hosted **spec-review agent** ([[../specs/spec-review-agent]]). Every newly authored spec lands in the `in_review` column — BEFORE `planned` — and the build dispatch is hard-stopped behind it. This cron drains the queue: whenever ≥1 in_review spec LACKS a current Vale review (per workspace), it inserts one `agent_jobs` row `kind='spec-review'` so the box's spec-review lane (`scripts/builder-worker.ts → runSpecReviewJob`) picks it up and reviews every unreviewed spec on Max.

[[../specs/vale-reactive-spec-review]] Phase 1 gated the enqueue on "lacks a current Vale review" (`status='in_review'` AND `deferred=false` AND `vale_pass !== true`): the durable review signal keys to spec CONTENT, so a tick that finds every in_review spec already Vale-passed no-ops for free and no Max session is spent re-reviewing content Vale already cleared. A re-author / send-back NULLs `vale_pass` via `markSpecCardBackToReview`, which re-admits the spec into the pool.

Same enqueue-only shape as [[spec-test-cron]] / [[triage-escalations]] — the box has no internal ticker, so an Inngest cron is the trigger. **This cron does NO reasoning** — purely the enqueue. The box keeps its secrets so the agent can read the prod DB; the WORKER is the only component that mutates state.

**File:** `src/lib/inngest/spec-review-cron.ts` (registered in `src/lib/inngest/registered-functions.ts`)

## Functions

### `spec-review-cron`
- **Trigger:** cron `*/15 * * * *` (every 15 minutes — the build pipeline is gated behind the in_review column, so the backlog can't sit long)
- **Retries:** 1
- **Concurrency:** `concurrency: [{ limit: 1 }]`

## What it enqueues

For each build-console workspace (any workspace with an [[../tables/agent_jobs]] row), the cron calls `enqueueSpecReviewIfDue(workspaceId)` ([[../libraries/agents-spec-review]]). That helper reads `public.specs` for rows with `status='in_review'` AND `deferred=false` AND `vale_pass !== true` (the "unreviewed" pool — [[../specs/vale-reactive-spec-review]] Phase 1). If there's ≥1 unreviewed spec AND no in-flight `spec-review` job for the workspace, it inserts a single `queued` `agent_jobs` row `kind='spec-review'` (`spec_slug='spec-review-sweep'`, a sentinel — Vale sweeps the queue, not one spec).

A workspace whose in_review pool is non-empty but fully Vale-passed gets `{enqueued:false, reason:'no-unreviewed-specs'}` — those specs are parked for Ada's disposition lane, not Vale's queue, so no Max session is spent re-reviewing content Vale already cleared. `no-in-review-specs` is the distinct "empty pool" reason.

## Dedupe

The cron does **not** dedupe itself — it delegates to `enqueueSpecReviewIfDue` (one-in-flight guard: skip when the workspace already has a `spec-review` job in `queued | queued_resume | building | claimed`). A cron tick that races an event-driven enqueue (future) no-ops cleanly.

## Downstream events sent

_None._ The box polls [[../tables/agent_jobs]] and claims the row; there is no HTTP call into the box (it only reaches out — [[../recipes/build-box-setup]]).

## Not the only trigger — the standing-pass backstop (2026-06-28)

This cron is **no longer the single point of failure** for getting an `in_review` spec reviewed. Three enqueuers now feed `runSpecReviewJob`, in increasing reliability:

1. **This Inngest cron** (`*/15`) — the original trigger. But it's an OUTSIDE-the-box signal that can silently miss (an Inngest sync/deploy reaps the function mid-tick, a transient run drops a beat, a workspace with no `agent_jobs` row is filtered out of its workspace scan).
2. **The build claim-gate** (`scripts/builder-worker.ts`) — when a build job for an unreviewed spec is dispatched, the gate `enqueueSpecReviewIfDue` + holds the build until Vale passes. But it only fires when a BUILD job for that spec is actually queued — an `in_review` spec with `auto_build=false` (or one whose build hasn't been queued yet) never trips it.
3. **The platform-director standing-pass backstop** ([[../libraries/platform-director]] `runPlatformDirectorStandingPass`) — the reliable heartbeat. Each pass, if ≥1 `in_review` spec lacks a live spec-review job it calls the SAME `enqueueSpecReviewIfDue` (deduped — no double-enqueue), then always runs `runAdaDispositionSweep` so a Vale-passed-but-undisposed spec advances `in_review→planned`. This is what guarantees a newly-authored spec gets reviewed even when (1) misses and (2) never applies (the 2026-06-28 `noop-pipeline-test-1` stall: 16h between cron-driven passes while a malformed in_review spec sat un-reviewed). Same standing-pass-heartbeat pattern as the Gate-A / pre-merge backstops.

All three converge on `enqueueSpecReviewIfDue`'s one-in-flight dedupe, so they never pile up.

## Status / open work

**✅ Shipped** (2026-06-25): registered in [[../libraries/control-tower]] `MONITORED_LOOPS` (id: `spec-review-cron`, kind: `cron`, owner: `platform`, window: 1h). Emits `loop_heartbeats` beats; the dashboard shows a tile in the every-15-min crons group; the Control Tower monitor watches for staleness.

**✅ Standing-pass backstop** (2026-06-28): the spec-review enqueue + Ada disposition sweep now also run as a best-effort step of the platform-director standing pass — so a missed cron tick can no longer strand an `in_review` spec. See [[../libraries/platform-director]].

## Tables written

- [[../tables/agent_jobs]] (inserts the `spec-review` job; one per workspace per cadence when due)
- `loop_heartbeats` (the cron's end-of-run heartbeat)

## Tables read (not written)

- [[../tables/agent_jobs]] (workspace discovery + in-flight dedupe)
- [[../tables/specs]] (the in_review queue per workspace — `status='in_review'`, `deferred=false`, `vale_pass !== true`)

## Contrast with `spec-test-cron`

Same enqueue-only shape, but **shorter cadence** (15 min vs daily) because spec-review is upstream of `planned` — every minute a sound spec sits in_review is throughput the build pipeline can't claim. The spec-test cron is downstream of `shipped`, so its cadence can be slack.

---

[[../README]] · [[../integrations/inngest]] · [[../libraries/agents-spec-review]] · [[../tables/agent_jobs]] · [[../recipes/build-box-setup]] · [[../specs/spec-review-agent]] · [[../project-management]]
