# libraries/pre-merge-fix

**fixes-as-phases** (2026-07-02) — on a RED pre-merge spec-test for an in-flight `claude/*` build branch, APPEND the failing checks as `kind='fix'` PHASES on the **ORIGIN** spec + resume the origin's build to fix them one-at-a-time. This RETIRES the old `fix-<slug>` spec model — a separate spec on a fresh branch/session that cold-rebuilt the whole origin from scratch and spawned `fix → fix-fix → fix-fix-fix` chains (the 2026-07-02 fix-loop + zombie-session mess).

**File:** `src/lib/pre-merge-fix.ts` · called inline from `scripts/builder-worker.ts` `runSpecTestJob` immediately after the shipped-only [[regression-agent]] branch (which misses pre-merge red because [[spec-test-runs]] `getHumanTestQueue` is shipped-only).

## The model — a fix is a phase on the origin

When the pre-merge spec-test returns `agent_verdict='issues'` with failing checks, `spawnPreMergeFix`:
1. Appends ONE `kind='fix'` phase ("Fix N") to the ORIGIN's `spec_phases` via [[specs-table]] `appendFixPhases` (INSERT-ONLY — never clobbers the origin's P1–P5). The phase body carries the failing checks + evidence; `spec_phases.origin_check_keys` records the [[spec-test-runs]] `check_key`s the fix must flip to `pass`.
2. Calls [[agent-jobs]] `queueNextChainedPhase` → resumes the origin's Claude session on its `claude/build-{slug}` branch and builds the Fix phase one-at-a-time (own commit). This is the "instant resumed-session build" the fix concept requires.

Two things then happen for FREE — **no explicit status write** (`specs.status` stays override-only NULL):
- **Appending a planned phase breaks accumulation** ([[specs-table]] `isSpecAccumulationComplete` → false) → [[brain-roadmap]] `applyInTestingOverlay` returns the base rollup → the origin derives OUT of `in_testing` back to `in_progress`. A spec-test regression re-opens the spec: it now has more steps to finish (P1–P5, Fix 1, …).
- **When the last (fix) phase ships**, the whole spec derives `shipped` → [[agent-jobs]] `applyMergedBuildEffects` fires `enqueueSpecTestIfDue` → the origin **self-re-tests**. Clean → promote; still red → another Fix N (bounded by the loop-guard). The full self-heal loop, reusing the chained-phase build/resume/accumulation machinery — no new spec row, no cold re-hydration, no `regression_of_slug` chain to depth-guard.

## External-test regressions are dropped, not appended (2026-07-14)

A pre-merge `unit_test` failure whose failing test file is NOT in the build branch's `git diff --name-only main...{branch}` is an **external regression** — the spec's branch never touched that test — and must NOT append a Fix phase to the innocent origin. Precedent: the media-buyer-digest spec (all code shipped) declared a `unit_test` check running `test:media-buyer-agent` — a test in `agent.test.ts` that the digest spec doesn't own — and an unrelated change transiently broke that test, stranding the shipped digest spec behind Fix 1 / Fix 2 / escalation for a regression it could never fix.

`spawnPreMergeFix` filters these the same way it filters `isHarnessCommandFailure` fails:

- The caller (`scripts/builder-worker.ts` `runSpecTestJob`) enriches each failing check with its `exec_kind` + `params.script` from [[../tables/spec_phase_checks]] (matched by [[spec-test-runs]] `checkKey`).
- `spawnPreMergeFix` computes `touchedFiles = git diff --name-only main...{branch}` + reads `package.json` scripts (both best-effort; a failure degrades to today's no-filter behaviour, never drops a real regression).
- For each unit_test check, [[spec-test-harness-classifier]] `isExternalTestRegression` resolves the test file(s) the script command runs (`resolveUnitTestFilesFromScript` — positional `*.test.{ts,tsx,mts,cts,js,jsx,mjs}` tokens) and returns `external:true` when NONE of them are in `touchedFiles`.
- An external regression is dropped from the append set + `recordDirectorActivity`'d as an `escalated` row (`metadata.signature='pre-merge-external-test-regression'`) naming the failing test file, its resolved test file paths, and the last committer of the primary test file (`git log -1 --format='%an <%ae>' -- <file>`) — so the regression is owned by whoever last touched the test, not the innocent spec.
- If ALL failing checks are external, `spawnPreMergeFix` returns `{ spawned:false, escalated:false, reason:"all failing checks are external-test regressions ..."}` — the auto-merge tests-gate still holds the PR (a red spec-test is still a red signal), but no Fix phase strands the spec.

## North star — bounded fix cycles, never silent retry

Hitting the rail = **escalate, not execute** ([[../operational-rules]] § North star). At `PRE_MERGE_FIX_LOOP_GUARD_MAX` (2) `kind='fix'` phases already on the origin, a still-red re-test records a [[../tables/director_activity|director_activity]] `escalated` row (`metadata.signature='fixes-as-phases-loop-guard'`) and does NOT append another Fix N — the fixes aren't converging, it's a deeper issue. The auto-merge gate's Phase-1 tests-gate still refuses to promote the red PR (fails CLOSED on a missing green signal), so escalate-without-append never promotes a red build.

## Exports

- `PRE_MERGE_FIX_LOOP_GUARD_MAX = 2` (env-overridable via `PRE_MERGE_FIX_LOOP_GUARD_MAX`) — fix-CYCLE cap per origin: after this many `kind='fix'` phases exist and the pre-merge spec-test is still red, the next RED escalates instead of appending another Fix N. Mirrors [[regression-agent]] `REGRESSION_LOOP_GUARD_MAX` (2).
- `spawnPreMergeFix(admin, { workspaceId, originSlug, originTitle, branch, failing })` → the chokepoint. Harness filter ([[spec-test-harness-classifier]] `isHarnessCommandFailure`) → external-test filter ([[spec-test-harness-classifier]] `isExternalTestRegression` — 2026-07-14, drops unit_test fails whose test files aren't in the branch diff and records a `director_activity` `escalated` row per drop) → loop-guard (escalate at the cap) → dedup (an UNBUILT fix phase covering the same `check_key` set → converge, re-kick the resumed build, no duplicate) → else [[specs-table]] `appendFixPhases` + [[agent-jobs]] `queueNextChainedPhase`. `fixSlug` in the result IS the origin slug (the fix lives on the origin now). Best-effort, never throws; returns a typed `SpawnPreMergeFixResult`.
- `readPackageScripts(repoRoot?)` / `computeBranchTouchedFiles(branch, repoRoot?)` — best-effort helpers the external-regression filter uses. `computeBranchTouchedFiles` shells `git diff --name-only main...{branch}` (the three-dot merge-base form); on any failure both return empty, and the external filter degrades to today's no-filter behaviour (safer to append a Fix than to drop a real regression).

## Trigger — inline from `runSpecTestJob`

`scripts/builder-worker.ts` `runSpecTestJob` classifies each run as pre-merge (`branch && previewOrigin` → `isPreMerge`). On `agent_verdict === "issues"` AND `isPreMerge`, it gathers the failing checks from the just-inserted [[spec_test_runs]] row's `checks[]` (each `c.verdict === 'fail'` → `{ text, evidence, check_key: checkKey(c.text) }`), pulls the origin title via [[specs-table]] `getSpec`, and calls `spawnPreMergeFix`. Post-merge runs on shipped specs hit the existing [[regression-agent]] path (this branch is inert there — `isPreMerge` is false).

## Security findings feed this too (2026-07-03)

A **fused pre-merge security review** (`consolidate-premerge-checks-one-session` — the spec-test session also reviews the branch diff for vulns) that returns `real-vuln` on an **in-flight branch** now routes through `spawnPreMergeFix` — the SAME fixes-as-phases path — instead of authoring a standalone security fix spec. `scripts/builder-worker.ts` `applyFusedSecurityAsBranchVerdict` intercepts the `real-vuln` verdict (branch mode only) and maps the envelope's findings → failing checks via `buildSecurityFailingChecks`, each with a STABLE `check_key` (`sec:<check>[:<location>]`) so the loop-guard + per-key dedup fire (no endless Fix N). The synthetic security-review row is marked terminal but NOT security-green (`verdict='real-vuln'`), so `isSecurityGreenForBranch` holds the PR until the fix phase ships and a FRESH fused (Vera + Vault) re-review of the origin's branch clears it.

- **Why:** standalone security fix specs on pre-merge branches raced the origin's own merge and produced superseded duplicate PRs — and, worse, the fix-spec's OWN branch got security-reviewed → another fix spec → a `fix-of-fix` chain (#1070/#1071/#1074/#1075, 2026-07-03). Making the fix a phase on the origin structurally removes the second spec, the second PR, and the recursion.
- **Post-merge (diff mode) is unchanged** — a security finding on already-merged code still authors a standalone follow-up spec via `authorSecurityFixSpec` + `routeSecurityFix` (there is no live branch build to append to). Only the pre-merge branch path was rerouted.
- **The re-test IS fused:** the fix phase ships on the origin's own `claude/build-{slug}` branch, so its re-test is a pre-merge run (`isPreMerge = !!previewOrigin && !!branch`) → Vera + Vault run together → a security fix is re-verified by Vault, not just Vera.

## Retired with fixes-as-phases (2026-07-02)

The `fix-<slug>` spec model + its chain guards are GONE from `pre-merge-fix.ts`: `preMergeFixChainDepth`, `buildPreMergeFixSlug`, `countPreMergeFixAttempts`, `PRE_MERGE_FIX_MAX_DEPTH`, and the `pre-merge-fix.test.ts` suite. The pre-merge path no longer sets `specs.regression_of_slug` or relies on [[agent-jobs]] `retestOriginIfFixMerged` — the origin re-tests itself when its own last phase ships. The [[../specs/pre-merge-fix-depth-guard-and-check-scoping]] spec's **Phase-1 depth-guard is obsolete** (no fix-chains); its Phase-2 (production-state assertion → `needs_human`) + Phase-3 (verification-authoring guidance) remain valid, independent check-quality work.

## Related

- [[specs-table]] — `appendFixPhases` / `countFixPhases` (the fix-phase writers), `spec_phases.kind` + `origin_check_keys`, `isSpecAccumulationComplete`
- [[agent-jobs]] — `queueNextChainedPhase` (the resumed one-phase build), `applyMergedBuildEffects` → `enqueueSpecTestIfDue` (self-re-test)
- [[spec-test-runs]] — `isSpecTestGreenForBranch` (the green signal the Phase-1 gate reads), `checkKey`, `getHumanTestQueue` (post-ship regressions)
- [[security-agent]] — `isSecurityGreenForBranch` (the other Phase-1 green signal)
- [[brain-roadmap]] — `applyInTestingOverlay` (board card derives `in_testing` from the SAME signals the gate reads; append breaks it back to `in_progress`)
- [[deploy-guardian]] — Reva's post-prod analogue, `DEPLOY_GUARDIAN_LOOP_GUARD_MAX`
- [[../tables/spec_phases]] — the `kind` / `origin_check_keys` columns a fix phase carries
- [[../tables/director_activity]] — `escalated` / `authored_fix` rows the recap reads back
