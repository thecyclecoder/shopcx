# libraries/self-verify-fix-phase

The PURE decompose-or-report decision behind the build lane's **"escaped to fix-phase self-heal"** branch — part of [[../specs/autobuild-circuit-break-on-repeated-pre-commit-self-verify-failure]] **Phase 2**.

**File:** `src/lib/self-verify-fix-phase.ts`

## Why

The pre-commit self-verify gate ([[../specs/build-lane-pre-commit-self-verify]], `scripts/builder-worker.ts` `runBuildJob` `preCommitSelfVerify`) resumes Bo up to `SELF_VERIFY_REPAIR_MAX` (2) in-session repair passes; on cap exhaustion it fails the job with `pre-commit self-verify unresolved after N repair passes: …` and logged **"escaped to fix-phase self-heal"**. But that branch **materialized nothing** — it only set the job `failed`, so `spec_phases` kept the original planned phases and the next build restarted from scratch and re-failed identically. Ground truth: `close-snapshot-coverage-guard` looped >1 month (builds 016fc2bd / 8803225e / 33c1d887 / 7e234f4c / fa28bba0) because its one failing check was `the registered test suite passes (unit_test)` — a WHOLE-ARTIFACT check that cannot decompose into a per-file fix phase, so "self-heal" was a silent no-op that re-fired Mario every tick.

## What it decides

`decideSelfVerifySelfHeal({ failing, existingFixPhases, loopGuardMax? })` returns a typed `SelfHealDecision`:

- **`{ action: 'append', fixes, signature, decomposableKeys }`** — one concrete fix phase per **per-anchor** (`grep`) failing check. Each fix carries a body naming the missing anchor + a `verification` that re-runs the SAME grep check (locally re-checkable), and `origin_check_keys` for dedup. The builder-worker branch appends them via [[specs-table]] `appendFixPhases`, so the NEXT build addresses them specifically.
- **`{ action: 'noop', reason, detail }`** — no per-file fix phase can help. `reason ∈`:
  - `all_whole_artifact` — every failing check is whole-artifact (`unit_test｜build｜tsc` run an entire suite/build/typecheck, not a per-anchor probe). This is the close-snapshot case.
  - `already_pending` — a still-unbuilt fix phase already covers EXACTLY these anchors (same sorted `origin_check_keys` signature) — don't stack a duplicate.
  - `loop_guard` — `>= SELF_VERIFY_FIX_PHASE_LOOP_GUARD_MAX` (default 3, env-overridable) fix phases already appended and still red — the fixes aren't converging.
  - `no_failing` — nothing failing.

On NOOP, the Phase-1 re-enqueue **circuit breaker** ([[agent-jobs]] `selfVerifyCircuitDecision` / `enqueueBuildIfDue`) is the explicit stop — it parks the spec after N consecutive identical self-verify failures instead of a silent clean-rebuild loop. The two phases compose: the breaker reads `agent_jobs.error` (unchanged by the append), so an appended fix that changes the failing set resets the breaker's streak, while a repeated identical failure counts toward it.

## Exports

- `decideSelfVerifySelfHeal(input)` — the pure decision (above).
- `isDecomposableSelfVerifyCheck(execKind)` — `true` for `grep` (per-anchor positive-absence); `false` for `WHOLE_ARTIFACT_SELF_VERIFY_KINDS` (`unit_test｜build｜tsc`) and unknown/null.
- `selfVerifyCheckKey(f)` — stable `<kind>:<normalized text>` dedup key.
- `WHOLE_ARTIFACT_SELF_VERIFY_KINDS`, `SELF_VERIFY_FIX_PHASE_LOOP_GUARD_MAX` — constants.
- Types: `SelfVerifyFailure`, `ExistingFixPhaseRow`, `SelfVerifyFixPhaseInput`, `SelfHealDecision`, `SelfHealNoopReason`.

## Wiring + observability

The builder-worker cap-exhaustion branch records ONE `director_activity` row per self-heal, `action_kind='build_self_verify_self_heal'` ([[director-activity]]), discriminated by `metadata.outcome` (`fix_phases_appended` with `appended_positions`, OR `self_heal_noop` with `noop_reason` + `detail`). Best-effort — a self-heal failure never changes the job's `failed` outcome.

**Verification pinned:** `src/lib/self-verify-fix-phase.test.ts` (whole-suite → noop, grep → append-per-anchor, mixed, pending-dedup, shipped-no-dedup, loop-guard, empty).
