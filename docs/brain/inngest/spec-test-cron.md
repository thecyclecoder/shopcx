# inngest/spec-test-cron

The **daily enqueuer** for the box-hosted **spec-test QA agent** ([[../specs/spec-test-agent]]). The box has no internal ticker, so this cron is the trigger (same pattern as [[triage-escalations]] / [[portal-auto-resume]]): once a day it finds every spec that is **shipped but not archived** and inserts one `agent_jobs` row `kind='spec-test'` per spec, per build-console workspace. The box worker ([[../recipes/build-box-setup]] → `runSpecTestJob`) does the actual QA pass. **This cron does NO reasoning** — it is purely the enqueue.

**File:** `src/lib/inngest/spec-test-cron.ts` (registered in `src/app/api/inngest/route.ts`)

## Functions

### `spec-test-cron`
- **Trigger:** cron `45 10 * * *` (daily at 10:45 UTC — offset from the other crons)
- **Retries:** 1
- **Concurrency:** `concurrency: [{ limit: 1 }]`

## What it enqueues

"Shipped but not archived" = `brain-roadmap` `deriveStatus` is `shipped` **AND** the spec is still in `docs/brain/specs/` with **no** `docs/brain/archive.d/{slug}.md` (`listArchivedSlugs`). For each such spec, for each workspace that uses the build console (has any [[../tables/agent_jobs]] row), it inserts one `queued` `agent_jobs` row `kind='spec-test'`. The box claims each on its **concurrency-1 `spec-test` lane** (`MAX_SPEC_TEST=1`) and runs the non-destructive `## Verification` checks on Max, writing a [[../tables/spec_test_runs]] row.

## Dedupe

It skips a `(workspace, slug)` that already has an **in-flight** `spec-test` job (`status` ∈ `queued|queued_resume|building|claimed`) **or** a **fresh run** (a [[../tables/spec_test_runs]] row in the last ~20h) — a daily sweep must never pile up or re-test the same spec twice a day. (The on-demand **Test now** button shares the same in-flight guard via `hasActiveSpecTestJob`.)

## Downstream events sent

_None._ The box polls [[../tables/agent_jobs]] and claims the row; there is no HTTP call into the box (it only reaches out — [[../recipes/build-box-setup]]).

## Tables written

- [[../tables/agent_jobs]] (inserts the `spec-test` jobs)

## Tables read (not written)

- [[../tables/agent_jobs]] (workspace discovery + in-flight dedupe)
- [[../tables/spec_test_runs]] (fresh-run dedupe)
- `docs/brain/specs/**` + `docs/brain/archive.d/**` (traced into the `/api/inngest` bundle in `next.config.ts`)

## Contrast with `triage-escalations`

Same enqueue-only shape as [[triage-escalations]] (box has no ticker → a cron inserts the job; reasoning happens on the box on Max), but **daily** (verification is not time-critical) and keyed on **shipped specs** rather than escalated tickets. Like triage, the box keeps its secrets so the agent can inspect prod read-only; unlike a code-build it opens **no PR**.

---

[[../README]] · [[../integrations/inngest]] · [[../tables/agent_jobs]] · [[../tables/spec_test_runs]] · [[../recipes/build-box-setup]] · [[../specs/spec-test-agent]] · [[../project-management]]
