# inngest/spec-test-cron

The **daily backlog sweep** for the box-hosted **spec-test QA agent** ([[../specs/spec-test-agent]]). Specs are now tested the moment they ship — an **event trigger** (spec-test-on-ship) enqueues a `spec-test` job on the manual status flip and on a build-merge, via the shared `enqueueSpecTestIfDue` guard in [[../libraries/agent-jobs]]. This cron is the **catch-all**: once a day it re-checks every spec that is **shipped but not archived** and enqueues any the event missed (box was down, or it shipped before the event existed). With the event trigger live, a healthy steady state means this cron usually finds nothing new. Same box-has-no-ticker pattern as [[triage-escalations]] / [[portal-auto-resume]]; the box worker ([[../recipes/build-box-setup]] → `runSpecTestJob`) does the actual QA pass. **This cron does NO reasoning** — it is purely the enqueue.

**File:** `src/lib/inngest/spec-test-cron.ts` (registered in `src/app/api/inngest/route.ts`)

## Functions

### `spec-test-cron`
- **Trigger:** cron `45 10 * * *` (daily at 10:45 UTC — offset from the other crons)
- **Retries:** 1
- **Concurrency:** `concurrency: [{ limit: 1 }]`

## What it enqueues

"Shipped but not archived" = `brain-roadmap` `deriveStatus` is `shipped` **AND** the spec is still in `docs/brain/specs/` with **no** `docs/brain/archive.d/{slug}.md` (`listArchivedSlugs`). It computes that candidate set in bulk (`getRoadmap` + `listArchivedSlugs`), then for each workspace that uses the build console (has any [[../tables/agent_jobs]] row) it calls `enqueueSpecTestIfDue(workspaceId, slug, 'shipped')` ([[../libraries/agent-jobs]]) per candidate — passing the already-derived `shipped` so the helper skips a redundant per-slug disk read. The helper inserts one `queued` `agent_jobs` row `kind='spec-test'` when due. The box claims each on its **concurrency-1 `spec-test` lane** (`MAX_SPEC_TEST=1`) and runs the non-destructive `## Verification` checks on Max, writing a [[../tables/spec_test_runs]] row.

## Dedupe

The cron does **not** dedupe itself — it delegates to the **shared `enqueueSpecTestIfDue` guard** ([[../libraries/agent-jobs]]) that the event triggers also use, so a cron tick racing a manual flip / build-merge no-ops the duplicate. The guard skips a `(workspace, slug)` that already has an **in-flight** `spec-test` job (`status` ∈ `queued|queued_resume|building|claimed`) **or** a **fresh run** (a [[../tables/spec_test_runs]] row in the last ~20h) — a sweep must never pile up or re-test the same spec twice a day. (The on-demand **Test now** button shares the same in-flight guard via `hasActiveSpecTestJob`.)

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

[[../README]] · [[../integrations/inngest]] · [[../libraries/agent-jobs]] · [[../tables/agent_jobs]] · [[../tables/spec_test_runs]] · [[../recipes/build-box-setup]] · [[../specs/spec-test-agent]] · [[../specs/spec-test-on-ship]] · [[../project-management]]
