# build-suspect-check

Pure detector + escalation-summary formatter for the suspect-check diagnosis on a deferred-PR redrive escalation. No I/O.

- **File:** `src/lib/build/suspect-check.ts`
- **Test:** `src/lib/build/suspect-check.test.ts` — pinned failing-state coverage (streak-firing, multi-check current-run bail, streak-breaker bail, ordering-agnostic, custom + meaningless thresholds, summary text shape).
- **Callers:** [[roadmap-actions]] `redriveDeferredBuildOrEscalate` (the escalate branch).

## Why

[[../specs/a-verification-check-must-not-demand-a-name-the-builder-has-to-guess]] Phase 1 stops NEW bad checks at author time via [[spec-phase-checks-table]] `detectBuilderChosenNameInGrep`; Phase 2 stops OLD ones from being escalated to the founder as *"build unbuildable"* when the real defect is a phase-check that pins a builder-chosen literal (`test:graduate-crowned` while the branch registered `test:media-buyer-graduate-scaler` — 5 identical failed builds on `bianca-actually-graduates-crowned-winners`, 4 on `factor-scores-reweight-selection-engine`). Two specs each burned ~5 builds on this shape; each escalation asked the CEO to reclaim a stuck build when the real ask was to loosen an over-strict grep.

## Exports

- **`detectSuspectCheck({ currentFailingKeys, priorRuns, threshold? })`** → `SuspectCheckResult | null`. Fires only when the CURRENT run has EXACTLY one failing check AND the same key was the ONLY failing key across a streak of ≥`threshold` (default 3, including current) consecutive prior redrive runs. Any ambiguity — multi-check current run, streak-breaker, short history — returns `null`; the detector fails CLOSED so a genuine build defect is never mislabeled.
- **`formatSuspectCheckSummary({ slug, suspect, checkDescription, phasePosition, checkPosition, failingPattern?, suggestedPattern?, nearMissEvidence? })`** → the escalation summary string the CEO sees. Renders `check X of phase Y has failed N builds while every other check passed — the check is the likely defect`, plus (when the caller supplies them) the branch's near-miss evidence and the one-command loosening remedy.

## Wire-in

[[roadmap-actions]] `redriveDeferredBuildOrEscalate` accepts an optional `failingChecks: DeferredRedriveFailingCheck[]`. On EVERY redrive it persists the derived [[spec-test-runs]] `checkKey` list into `director_activity.metadata.failing_check_keys`. On escalate it queries the spec's recent `redrive_deferred_build` rows (last 24h, capped at `2 * BUILDER_DEFERRED_REDRIVE_MAX`), extracts the prior keys, and runs `detectSuspectCheck`. On a fire, the escalation summary is rewritten via `formatSuspectCheckSummary`, and a `loosen_check` `pending_actions` entry (carrying the corrected pattern from [[spec-phase-checks-table]] `detectBuilderChosenNameInGrep`) is appended to the existing `reclaim_stuck_build` approval — the CEO sees an authoring defect to loosen, not a build defect to reclaim.

## Related

[[roadmap-actions]] · [[spec-phase-checks-table]] · [[spec-test-runs]] · [[agent-jobs]] · [[platform-director]] · [[../recipes/what-makes-a-buildable-spec]] · [[../specs/a-verification-check-must-not-demand-a-name-the-builder-has-to-guess]]
