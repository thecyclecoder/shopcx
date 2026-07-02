# inngest/spec-review-on-mutate

The **reactive trigger** for the box-hosted **spec-review agent** ([[../specs/spec-review-agent]]) — Vale looks at a newly-authored or re-opened `in_review` spec within seconds instead of waiting up to 15 minutes for the [[spec-review-cron]] tick.

[[../specs/vale-reactive-spec-review]] Phase 2. Fire-and-forget `spec-review/spec-mutated` events land here from the two mutation chokepoints that create or re-open an `in_review` spec:

1. **`src/lib/author-spec.ts`** — after a successful `upsertSpec` in BOTH entry points (`authorSpecRowStructured` and `authorSpecRowFromMarkdown`). Covers every fresh-authoring surface (submit-spec, spec-chat finalize, goal planner, triage, security, repair) since all route through this chokepoint.
2. **`src/lib/spec-card-state.ts` `markSpecCardBackToReview`** — the shared re-open writer every send-back funnels through (re-authored-with-changed-content re-open, the CEO board control, Ada's spec-status send-back, repair/regression).

Same relationship as [[spec-test-on-ship]] + [[spec-test-cron]]: the reactive event drives the steady state; the cron becomes a catch-up backstop for dropped events / cold workspaces / a workspace's first-ever `agent_jobs` row.

**File:** `src/lib/inngest/spec-review-on-mutate.ts` (registered in `src/lib/inngest/registered-functions.ts`)

## Function

### `spec-review-on-mutate`
- **Trigger:** event `spec-review/spec-mutated` — data: `{ workspace_id }`
- **Retries:** 1 — the enqueue helper is idempotent; a transient DB blip retries once and the 15-min cron backstop covers the rest.
- **Concurrency:** `[{ limit: 1, key: 'event.data.workspace_id' }]` — a burst of mutations in one workspace collapses to one enqueue check at a time; other workspaces run in parallel.

## What it does

Calls the SAME gated helper the 15-min cron uses — `enqueueSpecReviewIfDue(workspace_id)` from [[../libraries/agents-spec-review]]. That helper reads `public.specs` for `status='in_review'` AND `deferred=false` AND `vale_pass !== true` (the "unreviewed" pool). Three outcomes:

- **enqueued** — a `kind='spec-review'` `agent_jobs` row was inserted; the box's spec-review lane (`runSpecReviewJob`) picks it up within seconds.
- **no-unreviewed-specs / no-in-review-specs** — the current content already carries `vale_pass=true` (parked for Ada's disposition lane, not Vale's queue) OR the pool is empty. NO Max session spins up — the free SDK check inside the helper is the whole point of the gate.
- **in-flight** — a `spec-review` job is already queued/running for this workspace; the racing enqueue no-ops (the one-in-flight guard makes this idempotent against a cron tick fired at the same time).

## Downstream events sent

_None._ The box polls [[../tables/agent_jobs]] and claims the row.

## Tables written

- [[../tables/agent_jobs]] (inserts the `spec-review` job when the free SDK check finds real work)

## Tables read (not written)

- [[../tables/agent_jobs]] (in-flight dedupe)
- [[../tables/specs]] (the unreviewed in_review pool)

## Contrast with `spec-review-cron`

Same gated helper, opposite trigger shape. The reactive event fires the moment the mutation lands (near-zero latency in the common case); the cron ticks every 15 minutes and serves as the catch-up backstop when the event was dropped (Inngest sync mid-tick, transient run failure, workspace with no `agent_jobs` row at author time). Together they converge on `enqueueSpecReviewIfDue`'s one-in-flight dedupe, so they never pile up.

## Status / open work

**✅ Shipped** (Phase 2 of [[../specs/vale-reactive-spec-review]]): fire-and-forget events sent from `author-spec.ts` (both entry points) and `spec-card-state.ts` `markSpecCardBackToReview`; consumer registered in [[../libraries/registered-functions|registered-functions]].

---

[[../README]] · [[../integrations/inngest]] · [[../libraries/agents-spec-review]] · [[../tables/agent_jobs]] · [[../tables/specs]] · [[spec-review-cron]] · [[../specs/spec-review-agent]] · [[../specs/vale-reactive-spec-review]] · [[../project-management]]
