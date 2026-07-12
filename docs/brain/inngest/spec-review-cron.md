# inngest/spec-review-cron

**Status: RETIRED** — [[../specs/retire-vale-spec-review-becomes-deterministic-authoring-gate]] Phase 1–3.

The **RETIRED periodic enqueuer** for the NOW-CLOSED spec-review agent (Vale). **RETIRED:** the Vale LLM lane and its enqueue infrastructure are gone. The deterministic [[../libraries/spec-review-gate]] replaced Vale at the authoring chokepoint; a malformed spec is rejected instantly at author-time, and a well-formed spec passes by construction. The legacy `src/lib/inngest/spec-review-cron.ts` is a retired stub (registered in `INTENTIONALLY_UNMONITORED_CRONS` in [[../libraries/control-tower/registry]]). There is no longer an `in_review` waiting-room — specs that pass the authoring gate derive `planned`/`in_progress` via the phase rollup. The documentation below is HISTORICAL — it describes the retired enqueue loop, kept for operational reference only.

[[../specs/vale-reactive-spec-review]] Phase 1 gated the enqueue on "lacks a current Vale review"; vale-instant-per-spec-review tightened the predicate to `status='in_review'` AND `deferred=false` AND **`vale_pass IS NULL`**. The `vale_pass` tri-state keys to spec CONTENT: `null`=never verdicted (in the queue), `true`=passed (parked for Ada), `false`=needs_fix (out until re-authored). A tick where every in_review spec is already verdicted no-ops for free — no Max session spent re-reviewing cleared content. A re-author / send-back NULLs `vale_pass` via `markSpecCardBackToReview`, re-admitting the spec.

Same enqueue-only shape as [[spec-test-cron]] / [[triage-escalations]] — the box has no internal ticker, so an Inngest cron is the trigger. **This cron does NO reasoning** — purely the enqueue. The box keeps its secrets so the agent can read the prod DB; the WORKER is the only component that mutates state.

[[../specs/vale-reactive-spec-review]] Phase 2 added a REACTIVE partner — [[spec-review-on-mutate]] — that fires the SAME gated helper the moment a spec is authored or re-opened (via events sent from `author-spec.ts` and `spec-card-state.ts` `markSpecCardBackToReview`). This cron is now the **catch-up backstop** for dropped events / cold workspaces / a workspace's first-ever `agent_jobs` row — same relationship as [[spec-test-on-ship]] + [[spec-test-cron]].

**File:** `src/lib/inngest/spec-review-cron.ts` (registered in `src/lib/inngest/registered-functions.ts`)

## Functions

### `spec-review-cron`
- **Trigger:** cron `*/15 * * * *` (every 15 minutes — the build pipeline is gated behind the in_review column, so the backlog can't sit long)
- **Retries:** 1
- **Concurrency:** `concurrency: [{ limit: 1 }]`

## What it enqueues

For each build-console workspace (any workspace with an [[../tables/agent_jobs]] row), the cron calls `enqueueSpecReviewIfDue(workspaceId)` ([[../libraries/agents-spec-review]]). That helper reads `public.specs` for rows with `status='in_review'` AND `deferred=false` AND `vale_pass IS NULL` (the "unreviewed" pool). For each such spec that has no live `spec-review` job of its own, it inserts a `queued` `agent_jobs` row `kind='spec-review'` with `spec_slug`=**the real slug** (per-spec — vale-instant-per-spec-review). Returns `{enqueued, enqueuedCount, pending, reason?}`.

A workspace whose in_review pool is non-empty but fully verdicted gets `{enqueued:false, reason:'no-unreviewed-specs'}`; `no-in-review-specs` is the distinct "empty pool" reason.

## Dedupe

The cron does **not** dedupe itself — it delegates to `enqueueSpecReviewIfDue`. The guard is now **per-slug**: skip any spec that already has a `spec-review` job in `queued | queued_resume | building | claimed`, and yield entirely to a legacy `spec-review-sweep` sentinel job if one is in flight (`reason:'batch-in-flight'`). So the cron, the ~30s box poll, the reactive event, and the standing-pass all converge idempotently — a spec never gets two concurrent sessions.

## Downstream events sent

_None._ The box polls [[../tables/agent_jobs]] and claims the row; there is no HTTP call into the box (it only reaches out — [[../recipes/build-box-setup]]).

## Not the only trigger — the standing-pass backstop (2026-06-28)

This cron is **not** the primary enqueuer anymore. Four enqueuers now feed `runSpecReviewJob`, all converging on the same per-slug dedup:

0. **The box ~30s reconcile poll** (`runSpecReviewEnqueueReaper`, `scripts/builder-worker.ts`) — **the primary path** (vale-instant-per-spec-review). An INSIDE-the-box loop that can't be reaped by an Inngest sync and doesn't depend on an event the box can't reliably send. Finds every unreviewed in_review spec and enqueues per-spec within ~30s of authoring.
1. **This Inngest cron** (`*/15`) — a catch-up backstop. An OUTSIDE-the-box signal that can silently miss (Inngest sync/deploy reaps it mid-tick, a transient run drops a beat).
2. **The build claim-gate** (`scripts/builder-worker.ts`) — when a build job for an unreviewed spec is dispatched, the gate `enqueueSpecReviewIfDue` + holds the build until Vale passes. Only fires when a BUILD job for that spec is queued.
3. **The platform-director standing-pass backstop** ([[../libraries/platform-director]] `runPlatformDirectorStandingPass`) — the reliable heartbeat; also runs `runAdaDispositionSweep` so a Vale-passed-but-undisposed spec advances `in_review→planned`.

All converge on `enqueueSpecReviewIfDue`'s per-slug dedupe, so they never pile up.

## Status / open work

**✅ Shipped** (2026-06-25): registered in [[../libraries/control-tower]] `MONITORED_LOOPS` (id: `spec-review-cron`, kind: `cron`, owner: `platform`, window: 1h). Emits `loop_heartbeats` beats; the dashboard shows a tile in the every-15-min crons group; the Control Tower monitor watches for staleness.

**✅ Standing-pass backstop** (2026-06-28): the spec-review enqueue + Ada disposition sweep now also run as a best-effort step of the platform-director standing pass — so a missed cron tick can no longer strand an `in_review` spec. See [[../libraries/platform-director]].

## Tables written

- [[../tables/agent_jobs]] (inserts one `spec-review` job PER unreviewed spec when due)
- `loop_heartbeats` (the cron's end-of-run heartbeat)

## Tables read (not written)

- [[../tables/agent_jobs]] (workspace discovery + per-slug in-flight dedupe)
- [[../tables/specs]] (the in_review queue per workspace — `status='in_review'`, `deferred=false`, `vale_pass IS NULL`)

## Contrast with `spec-test-cron`

Same enqueue-only shape, but **shorter cadence** (15 min vs daily) because spec-review is upstream of `planned` — every minute a sound spec sits in_review is throughput the build pipeline can't claim. The spec-test cron is downstream of `shipped`, so its cadence can be slack.

---

[[../README]] · [[../integrations/inngest]] · [[../libraries/agents-spec-review]] · [[spec-review-on-mutate]] · [[../tables/agent_jobs]] · [[../recipes/build-box-setup]] · [[../specs/spec-review-agent]] · [[../specs/vale-reactive-spec-review]] · [[../project-management]]
