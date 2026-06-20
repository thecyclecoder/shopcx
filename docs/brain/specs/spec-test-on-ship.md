# Spec-Test on Ship (event-trigger, cron = backlog) ✅

**Owner:** [[../functions/platform]] · **Parent:** extends [[spec-test-agent]]. We ship often, so a once-a-day QA sweep is too slow — **test a spec the moment its card moves to Shipped**, and demote the daily cron to a backlog catch-all.

Today [[spec-test-agent]] only runs off `spec-test-cron` (daily). This adds an **event trigger**: whenever a spec transitions to **shipped**, immediately enqueue its `spec-test` job. The daily cron stays — but only to mop up anything the event missed (a spec that shipped while the box was down, an older shipped spec never tested).

## The two "moves to shipped" paths → both enqueue
A spec becomes shipped one of two ways; hook each:
1. **Manual** — the owner flips status/phase via `StatusControl`/`PhaseList`, which both POST `/api/roadmap/status` (the single chokepoint that commits the emoji to the brain on main). **After the commit, if the spec's resulting derived status is `shipped`** ([[../libraries/brain-roadmap]] `deriveStatus` over the new phase set), enqueue a `kind='spec-test'` job for that slug.
2. **Build-driven** — a build flips the spec's phase emojis to ✅ in its PR; on merge the spec becomes shipped. Hook **`reconcileMergedJobs`** ([[../libraries/agent-jobs]], already run on board load + the merge path): when a build job is reconciled as merged **and** its spec's derived status is now `shipped` (and wasn't tested for this state), enqueue the `spec-test` job.

## Dedupe (reuse the cron's guard)
Both hooks + the cron share one guard (factor it out): **skip a (workspace, slug) that already has an in-flight `spec-test` job OR a fresh `spec_test_runs` row** (within a short window, e.g. the last few hours / since the spec's last change). So a build-merge + a manual status tweak + the cron don't triple-run; the first one wins and the rest no-op. Re-running is still possible after the spec changes again (a new ship state).

## Daily cron = backlog only
`spec-test-cron` is unchanged in mechanism but reframed: its job is the **backlog sweep** — catch shipped-unverified specs with **no recent run** (the event trigger missed them: box was down, or they shipped before this existed). With the event trigger live, a healthy steady state means the cron usually finds nothing new.

## Verification
- Move a planned/in-progress spec to **Shipped** via the board's status control → within a poll cycle a `spec-test` job appears for that slug and a `spec_test_runs` row follows (no waiting for the daily cron).
- Merge a build whose PR ships a spec → the same spec-test fires on reconcile.
- Do both (or add the cron tick) for one slug in a short window → only **one** run (dedupe holds). Change the spec + re-ship → a fresh run is allowed.
- The daily cron, with the event trigger live, enqueues only specs lacking a recent run.

## Phase 1 — event triggers + shared dedupe ✅
Factored the cron's "shipped-unverified + not-recently-run" check into a shared `enqueueSpecTestIfDue(workspaceId, slug, knownStatus?)` helper in [[../libraries/agent-jobs]] (dedupe = no in-flight `spec-test` job + no fresh `spec_test_runs` row ~20h). Called from (a) `/api/roadmap/status` after a commit whose `deriveSpecStatus` yields `shipped` (new `deriveSpecStatus` export on [[../libraries/brain-roadmap]] derives over the just-committed content, since the deployed bundle's disk is stale), and (b) `reconcileMergedJobs` when a merged `build` job's spec — fetched from `main` — is now shipped. The daily cron calls the same helper per backlog slug (passing `'shipped'`). Brain updated: [[spec-test-agent]] (event trigger) + [[../inngest/spec-test-cron]] (backlog-only) + new [[../libraries/agent-jobs]] page. Fold on ship.
