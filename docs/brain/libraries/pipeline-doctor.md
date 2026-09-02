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
- **`CLASSIFIERS`** — the ordered list of named anomaly classifiers (the extension point). See the [[../recipes/pipeline-doctor]] table for each detector's meaning + source signals: `stored-status-override-violation` (CRITICAL), `failed-gate`, `zombie-session`, `stuck-in-testing`, `built-not-stamped`, `in-testing-needs-human`, `awaiting-human`, `drift-suspect`, `shipped-not-folded`, `not-claimed`, `deferred-parked`.
- **`BUILT_NOT_STAMPED_STATUSES`** — the shared status set that gates `detectBuiltNotStamped` (`{ "planned", "in_progress" }`). **DO NOT narrow this to a single status** (see the reachability trap below). Pinned by `npm run test:built-not-stamped`.
- **`detectBuiltNotStamped`** / **`detectInTestingNeedsHuman`** — exported so the pinning tests can invoke them directly with a synthesized `SpecDiagnosis`, no DB.
- **`Severity`** = `none｜info｜low｜medium｜high｜critical`; plus `DetectorResult`, `PhaseDiag`, `JobDiag`, `SpecTestDiag` (carries `cleanMachinePass: boolean` — see the greenness rule below), `DiagnoseOptions` types.

## Greenness comes from `isCleanMachinePassRun` — human checks never make a spec stuck  *(pipeline-doctor-honors-human-checks-are-advisory Phase 1)*

The doctor's "is spec-test green?" answer is DELEGATED to the SHARED [[spec-test-runs]] `isCleanMachinePassRun` predicate — the SAME gate the pre-merge promote rail ([[brain-roadmap]] Rail 1 at :998) and the post-ship fold rail ([[spec-test-runs]] `getAutoFoldEligibleSlugs` Rail 2) already use. `SpecTestDiag.cleanMachinePass` is computed at assembly time from `(run, humanResolutions, slug)` and the module-private `specTestGreen` reads that boolean; the classifier `detectInTestingNeedsHuman` returns null when it is true.

**Human checks are ADVISORY.** A `needs_human` verdict with ≥1 check and 0 unresolved auto-`fail` is a clean machine pass and promotes on its own — the doctor MUST agree with the promote/fold rails, so it does not re-decide green from the raw verdict string. The classifier still fires for the case it was really for: a `needs_human` verdict that also carries an unresolved auto-`fail` (a real machine failure hiding inside an advisory verdict); its `suggestedAction` names the machine fail as the blocker, never the advisory human checks. Ground-truth incident: 2026-08-31 playbook-drift-classifier-sees-the-pending-question ran with three auto-passes, zero fails and two advisory human checks (a harness gap — no `gh` binary), and the doctor still reported it stuck; the two rails agreed it was clean. Pinned by `npm run test:doctor-human-advisory`.

## `shipped-not-folded` — the doctor sees a spec whose phases all shipped but the fold gate keeps refusing  *(a-shipped-spec-that-cannot-fold-is-stuck Phase 1)*

The fold gate is a separate rail from build / spec-test / security / merge — and before this fix the doctor's classifiers stopped at those four, so a spec whose phases had all shipped but which [[spec-test-runs]] `getAutoFoldEligibleSlugs` kept refusing was reported as perfectly healthy. Over 2026-08-31 and 2026-09-02 that happened four separate times: specs sat shipped-but-unfolded for days while the doctor reported zero stuck, and the founder noticed every time. The refusal reasons were real and specific — a squash merge had discarded the ancestry the containment check needs, a security review had never been queued, a phase had no build evidence — and every one of them was already computed by the fold gate and thrown away, because nothing asked.

- **The fold gate now exposes its refusals.** [[spec-test-runs]] `getFoldRefusalsBySlug` returns the per-slug refusal map from the SAME evaluation as `getAutoFoldEligibleSlugs` (both call the internal `evaluateAutoFoldGate` — one definition, two rails, no drift). Refusal reasons are populated for shipped-and-un-archived specs the gate rejected this pass; an eligible spec has no entry. Same single-definition rule [[isCleanMachinePassRun]] already enforces for spec-test greenness.
- **`SpecDiagnosis.foldRefusal`** — nullable string carrying the gate's refusal at assembly time (`diagnosePipeline` batches `getFoldRefusalsBySlug` alongside the other canonical reads; `diagnoseSpec` plucks the one slug's entry). Null when the spec isn't shipped, is eligible, or the lookup blipped.
- **`detectShippedNotFolded`** — fires when ALL hold: derivedStatus === "shipped" (same rail every other classifier uses) · `rawStatus` is neither `deferred` nor `folded` (a parked / already-folded spec is not stuck) · no LIVE build/spec-test/fold/goal-fold job (mirror the fold gate's own in-flight defer or the board would alarm on healthy work) · `foldRefusal` is populated · the newest job activity is at least **12 hours** old (comfortably longer than the reactive fold enqueue lag and the daily sweep — a spec that just shipped is NOT stuck).
- **Severity `medium`** — the code is on main and working, so this is bookkeeping debt, not a broken build. But it compounds silently, which is exactly why the board must surface it.
- **`suggestedAction` IS the fold gate's refusal** — the whole point of the spec. A board that says WHY (e.g. `"an OPEN PR still carries branch claude/build-…"`) is what closes the visibility gap; a generic "investigate" is exactly as useful as no signal at all.

Pinned by `npm run test:doctor-shipped-not-folded` — one positive case (shipped + past-window + no live job → STUCK, reason contains the gate's refusal) plus four load-bearing negatives (inside the grace window · live build job · `deferred` · `folded`). The negatives are the critical ones — a detector that cries wolf on healthy in-flight work gets ignored, which would recreate the very blindness this closes.

## The `built-not-stamped` reachability trap  *(unstamped-phase-cannot-silently-strand-a-build Phase 1)*

`detectBuiltNotStamped` alarms on the "the build ran yet `stampPhaseBuilt` never advanced any phase" case — its reason string names exactly that. Its status guard **MUST admit `planned`**, not only `in_progress`, because:

- Spec status is a rollup over DERIVED phase status ([[brain-roadmap]] `deriveSpecCardStatus` → `rollupPhaseStatus`), and [[specs-table]] `derivePhaseStatus` returns `in_progress` **only when `build_sha` is non-null**.
- The missed-stamp case is precisely `build_sha === null` on every phase. So every phase derives `planned`, the spec derives `planned`, and a `derivedStatus === "in_progress"` guard is **mutually exclusive with the case the classifier is written to catch**. The alarm reads as coverage while being permanently unreachable — the worst kind of dark signal.

The current guard is `BUILT_NOT_STAMPED_STATUSES.has(d.derivedStatus)` with the set `{"planned", "in_progress"}`; the other two guards (latest build job is `completed`/`merged`, `anyPhaseBuilt` is false) are what make the signal specific — a spec that never built is correctly ignored (no completed build job), a spec that advanced normally is correctly ignored (`anyPhaseBuilt` trips). **Do not narrow the status set to one value again; the pinning test `test:built-not-stamped` fails deterministically if you do.** Ground-truth incident: the card-removal spec sat 17 hours with an open, mergeable, CI-green PR carrying a real credential leak, because the one alarm for the failure could not fire in the exact case it names.

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
