# libraries/pipeline-doctor

**Read-only diagnosis of the whole spec pipeline** — the CEO's "what's stuck and WHY?" probe, packaged once so every session reads the SAME derived truth instead of hand-writing ad-hoc SQL. For each board spec it assembles the **derived status** (the canonical roadmap rollup), the per-phase build/ship provenance, the latest job per lifecycle kind, the spec-test + security rollups, the lifecycle gate it's parked at, and a `stuck` verdict from a set of named, extensible anomaly classifiers (the WHY).

**File:** `src/lib/pipeline-doctor.ts` · **CLI:** `scripts/pipeline-status.ts` · **How-to:** [[../recipes/pipeline-doctor]]

> ⚠️ **READ-ONLY by construction.** This module performs NO writes — no status flips, no enqueues, no DB mutations. It only reads. The `suggestedAction` on each detector NAMES the fix to run; the doctor never executes it.

## Why this exists

The pipeline state lives across many tables ([[../tables/specs]], [[../tables/spec_phases]], [[../tables/agent_jobs]], [[../tables/spec_test_runs]], security-review jobs) and is only meaningful through the DERIVED rollups. Diagnosing "what's stuck" by hand meant re-writing the same probe scripts every session — and a raw re-derivation **drifts** from the board (the canonical derived status). This module COMPOSES the canonical readers so the diagnosis can never disagree with the Roadmap board / fold gate.

## Composes (never re-derives)

- [[brain-roadmap]] `getRoadmap` — the canonical DERIVED card status + phases (incl. `build_sha`/`merge_sha`/`pr`, `onGoalBranch`).
- [[agent-jobs]] `getLatestJobsBySlug` (+ a batched per-`(slug, kind)` `agent_jobs` read for build/spec-test/security-review/fold/goal-fold), `ACTIVE_STATUSES`.
- [[spec-test-runs]] `getLatestSpecTestRuns` / `getLiveSpecTestSlugs` / `getHumanCheckResolutions`; [[build-lifecycle-context]] `specTestHasOpenRegression`.
- [[security-agent]] `getSecurityStateBySlug` — the `live`/`surfaced`/`completedClean` rollup.
- [[build-lifecycle-context]] `buildLifecycleContext` + [[build-lifecycle]] `deriveLifecycleStage` — the lifecycle gate the spec is parked at.

The **ONE** targeted raw read is `specs.status` (the OVERRIDE-ONLY column the canonical readers deliberately never surface — required by the stored-status-override check) plus `milestone_id` (goal binding) + `deferred`. Everything else is a canonical reader.

## Key exports

- **`diagnosePipeline(opts?)`** → `Promise<PipelineDiagnosis>`. `opts`: `{ workspaceId?, includeHealthy?, sinceHours?, slug? }`. Resolves the build-console workspace by default (ride the latest `agent_jobs` row, else oldest workspace — mirrors [[brain-roadmap]]'s shim). `slug` is a single-spec deep dive; `includeHealthy` adds non-anomalous specs; `sinceHours` is a staleness floor (only count an anomaly ≥N hours old as stuck).
- **`PipelineDiagnosis`** — `{ workspaceId, generatedAt, totals: { total, stuck, healthy, awaitingHuman, bySeverity }, storedStatusViolations: SpecDiagnosis[], lanes: { buildPoolSize, activeBuilds }, specs: SpecDiagnosis[] }`. `specs` is stuck-first sorted; the default (non-`includeHealthy`) set is stuck + awaiting-human only.
- **`SpecDiagnosis`** — per spec: `slug`, `title`, `owner`, `parent`, `goalSlug` (via `milestone_id`), `derivedStatus`, `rawStatus` (the override column), `phases: PhaseDiag[]`, `jobs: JobDiag[]` (latest per kind, with `ageMinutes` + `heartbeatAgeMinutes`), `specTest`, `security`, `lifecycle` (the gate), `detectors: DetectorResult[]`, and `stuck: StuckVerdict`.
- **`StuckVerdict`** — `{ isStuck, severity, detector, reason, sinceMinutes, suggestedAction }`. Primary = the highest-severity matched detector; `deferred-parked`/`awaiting-human` (and any deferred spec) are never `isStuck`.
- **`CLASSIFIERS`** — the ordered list of named anomaly classifiers (the extension point). See the [[../recipes/pipeline-doctor]] table for each detector's meaning + source signals: `stored-status-override-violation` (CRITICAL), `failed-gate`, `zombie-session`, `stuck-in-testing`, `built-not-stamped`, `in-testing-needs-human`, `awaiting-human`, `drift-suspect`, `not-claimed`, `deferred-parked`.
- **`Severity`** = `none｜info｜low｜medium｜high｜critical`; plus `DetectorResult`, `PhaseDiag`, `JobDiag`, `SpecTestDiag`, `DiagnoseOptions` types.

## Callers

- `scripts/pipeline-status.ts` — the CLI (`--all` / `--slug` / `--since` / `--json`).

## Gotchas

- **`spec-test` is a real job kind missing from the `JobKind` union** (enqueued by [[agent-jobs]] `enqueueSpecTestIfDue`). The doctor types its kind set as `string[]` so it can read those rows.
- **The zombie threshold mirrors the reaper** (`REAP_STALE_MS` = 20 min in `scripts/builder-worker.ts`) so the doctor agrees with what the reaper will actually reap; the pool-occupancy context uses `MAX_CONCURRENT` (8).
- **Best-effort batched reads** — a missing optional reader (e.g. `spec_status_history` for a defer reason) degrades to a less-detailed diagnosis, never an error.

## Related

[[../recipes/pipeline-doctor]] · [[brain-roadmap]] · [[agent-jobs]] · [[spec-test-runs]] · [[security-agent]] · [[build-lifecycle]] · [[build-lifecycle-context]] · [[specs-table]] · [[../lifecycles/spec-goal-branch-pm-flow]] · [[../lifecycles/roadmap-build-console]]

---

[[../README]] · [[../../CLAUDE]]
