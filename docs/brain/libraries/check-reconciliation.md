# libraries/check-reconciliation

Self-heal a stale/over-precise `expect: 'present'` grep check on the build branch BEFORE the phase-accumulation verify path defers the PR ([[../specs/build-verify-self-heals-stale-grep-checks-before-deferring]] Phase 1).

**File:** `src/lib/build/check-reconciliation.ts` — exports `reconcileStaleGrepCheck`, `reconcileFailingGrepChecksForSpec`, `defaultBatchDeps`, and the `FailingGrepCheck` / `ReconcileDeps` / `BatchReconcileDeps` / `ReconciliationAudit` types.

## The wedge

A phase's grep check pins an EXACT literal that the spec author guessed BEFORE the code existed. The builder routinely ships functionally-correct code under a different literal:

| Wedge class | Old pattern | New literal on branch |
|---|---|---|
| Renamed symbol | `upsertColdScalerCohort` | `provisionColdScalerCohort` |
| Case / form drift | `IS NULL` | `is null` |
| Reworded token | `quant-desk` | `Quant-desk` |
| Formatter-inserted whitespace | `export async function fooBar` | `export\n  async function fooBar` |

Phase-accumulation verification (`isSpecAccumulationComplete` in [[specs-table]] → `verifyPhaseAccumulatedOnBranch`) git-greps the stale literal, finds no match, marks the phase unverified, and parks the COMPLETED build with a DEFERRED PR — a false negative where the code is genuinely present.

## The self-heal

`reconcileStaleGrepCheck({check, branchRef, repoRoot, deps})` runs two ordered steps and returns `{reconciled: true, newPattern, step, rationale, evidence}` or `{reconciled: false, reason, evidence?}`.

### Step A — normalized re-match (deterministic, cheap)

A case-insensitive + whitespace-tolerant ripgrep against the same path on the branch. Runs of whitespace in the pattern rewrite to `\s+` (matches a formatter-inserted line break); everything else regex-escapes so a plain-string pattern stays plain. On a hit, the FIRST matched line's substring corresponding to the original pattern is returned as the candidate literal — the pattern repoints to the ACTUALLY-present casing.

This catches the vast majority of the wedge — case / whitespace drift — with no LLM call.

### Step B — bounded intent judge (only if A misses) — AUTO-APPLIES a confident proposal

Reads:
- The check's `description` — the INTENT the author wrote in prose (e.g. "reconciler defined").
- The phase's branch DIFF for `params.path`, bounded to 16 KB via `git diff origin/main...<branchRef> -- <path>`.

Asks Claude Sonnet (`SONNET_MODEL` from [[ai-models]]) to decide whether the diff satisfies the described intent under a DIFFERENT literal and, if so, return the EXACT literal present in the diff. Strict-JSON output: `{literal: string|null, rationale: string}`. Max 400 output tokens. Fail-closed on any API / parse error → `literal: null`.

**AUTO-APPLIES a confident proposal** ([[../specs/build-verify-reconciler-auto-applies-renames-and-moved-symbols]] Phase 1). When the judge returns a non-null literal AND the runner's real deterministic grep of that literal on the branch passes, the caller repoints the pattern via `upsertPhaseChecks` (`{reconciled: true, step: 'judge_repoint_auto_applied', newPattern, rationale, evidence}`) — same replace-by-position semantics as step A. **The deterministic grep IS the safety gate** (`defaultRunDeterministicGrep`, identical argv to the runner's `defaultExecutors.grep`): a judge proposal that doesn't actually match the branch never lands. A judge that returns null → `{reconciled: false, reason: 'judge_declined'}`; a proposal whose final grep fails → `{reconciled: false, reason: 'proposal_did_not_match'}` — the caller defers/escalates exactly as before (a real code-missing signal is never masked). The previous "advisory only / needs-human" path is retired: parking real, fully-built specs on a rename was itself the wedge this spec closes.

**Residual prompt-injection risk** — a crafted diff can steer the judge to an unrelated but present literal that DOES grep. Bounded by (a) `maxReconciliationsPerBuild` in `reconcileFailingGrepChecksForSpec` (a pathological spec whose EVERY grep check is stale can't silently pass) and (b) the `check_reconciled` [[../tables/director_activity]] row emitted for EVERY repoint (`step='judge_repoint_auto_applied'`) — every auto-correction lands on the CEO-facing build card, never silent. A mis-guessed spec can't hide behind the reconciler.

## Invariants

1. **`expect: 'present'` ONLY.** An `expect: 'absent'` miss is a different, real signal (the code SHOULDN'T be there and IS) — never reconciled.
2. **Every repoint (step A OR step B) MUST still pass a real deterministic grep of the new pattern before it lands** (`defaultRunDeterministicGrep`, identical argv to the runner's `defaultExecutors.grep`) — no bypass, no phantom-ship. The final grep is the safety gate.
3. **A judge that returns null OR whose candidate fails the final deterministic grep NEVER auto-reconciles** — the check surfaces as unhealed and the caller defers/escalates exactly as before. A real code-missing signal is never masked.
4. **Capped per build.** `reconcileFailingGrepChecksForSpec` accepts `maxReconciliationsPerBuild` (default: total grep-check count in the spec). Exceeded → any remaining unhealed checks report `cap_reached` and the caller defers as before.
5. **Every reconciliation is surfaced — never silent.** Each successful repair (step A OR step B) writes a `director_activity.action_kind='check_reconciled'` row carrying the `step` that fired (`normalized_case` | `judge_repoint_auto_applied`); the worker mirrors it into the run log tail.
6. **Best-effort** — a thrown reconciler falls through to the existing defer path unchanged. The reconciler NEVER masks a real code-missing failure.

## Contract

```ts
export interface FailingGrepCheck {
  phaseId: string;          // spec_phases.id — target for upsertPhaseChecks
  phasePosition: number;    // 1-based phase position (audit/log)
  checkPosition: number;    // spec_phase_checks.position — target for upsert
  description: string;      // the INTENT the judge reads
  params: GrepCheckParams;  // expect MUST be 'present'
}

reconcileStaleGrepCheck({ check, branchRef, repoRoot, deps })
  → { reconciled: true, newPattern, step: 'normalized_case' | 'judge_repoint_auto_applied', rationale, evidence }
  | { reconciled: false, reason, evidence? }
  // step B auto-applies a confident proposal — the deterministic grep is the safety gate.
  // reason ∈ 'not_present_grep' | 'no_normalized_match' | 'judge_declined' | 'proposal_did_not_match' | 'harness_error'.

reconcileFailingGrepChecksForSpec({ workspaceId, slug, branchRef, repoRoot, deps, maxReconciliationsPerBuild? })
  → {
      reconciled: ReconciliationAudit[],
      unreconciled: Array<{ phaseId, phasePosition, checkPosition, description, oldParams, reason, evidence? }>,
      capReached: boolean,
      totalGrepChecks: number,
      failingGrepChecks: number,
    }
```

`ReconciliationAudit` carries every field the audit surface needs: workspace, slug, phase, check description, `oldPattern`, `newPattern`, `step`, `rationale`, `evidence`.

## DI + defaults

Every dep is injectable so tests drive the whole policy without touching shell/DB/network:

| Dep | Default |
|---|---|
| `normalizedGrep` | `defaultNormalizedGrep` — `rg -n -i -e <whitespace-tolerant pattern> -- <path>` in `repoRoot`. |
| `loadPhaseDiff` | `defaultLoadPhaseDiff` — `git diff origin/main...<branchRef> -- <path>`, bounded to 16 KB. |
| `intentJudge` | `defaultIntentJudge` — Sonnet (`SONNET_MODEL`), max 400 tokens, strict JSON, fail-closed on API/parse error. `ANTHROPIC_API_KEY` unset → `{literal: null}`. |
| `runDeterministicGrep` | `defaultRunDeterministicGrep` — identical argv shape to `defaultExecutors.grep` in [[spec-check-runner]] (`-e <pattern> -- <path>`). |
| `loadPhaseGrepChecks` (batch) | `defaultLoadPhaseGrepChecks` — [[specs-table]] `getSpec` → [[spec-phase-checks-table]] `listPhaseChecks` filtered to `exec_kind='grep'`. |
| `upsertReconciledCheck` (batch) | `defaultUpsertReconciledCheck` — re-reads the phase's full check list, replaces the single position's params, calls [[spec-phase-checks-table]] `upsertPhaseChecks` (replace-by-position preserves ids). |

`defaultBatchDeps` bundles all defaults so [[builder-worker]] calls the batch helper with a single import.

## Where it's called

`finalizeBuiltPhase` (in [[builder-worker]] `runBuildJob`), inside the `!acc.complete` branch, BEFORE the defer. On a successful reconcile the accumulation is re-read; if now complete, the PR opens instead of deferring. On no-reconcile the branch defers/escalates exactly as before.

## Audit surface — never silent ([[../specs/build-verify-self-heals-stale-grep-checks-before-deferring]] Phase 2)

A self-healing check that isn't visible is a proxy that optimizes itself — the exact "silent proxy-optimizer" the [[../operational-rules]] § North star forbids. Every reconciliation MUST land on the CEO-facing build-card feed so an auto-correction can be eyeballed, and a mis-guessed spec can't hide behind the reconciler.

### Per-repair row — `director_activity.action_kind='check_reconciled'`

`defaultAuditReconciliation` in `src/lib/build/check-reconciliation.ts` is the default `auditReconciliation` dep on `defaultBatchDeps`. It writes ONE [[../tables/director_activity]] row per successful repair via [[director-activity]] `recordDirectorActivity`:

- `director_function`: `'platform'` (Ada's feed).
- `action_kind`: `'check_reconciled'` (a new vocabulary entry on `DirectorActionKind` — see [[director-activity]]).
- `spec_slug`: the spec whose check was repointed.
- `reason`: one line — `phase N check '<description>' auto-corrected via <step>: 'old' → 'new' — <rationale>`.
- `metadata`: `{ spec_slug, phase_id, phase_position, check_position, check_description, old_pattern, new_pattern, step: 'normalized_case' | 'judge_repoint_auto_applied', rationale, evidence, autonomous: true }`.

Best-effort + never throws — a director-activity blip is worse than the gap it records. The row is what the EOD recap, Ada's activity feed, and the #directors board post read.

### Cap-reached / defer-with-unhealed row — `director_activity.action_kind='check_reconcile_cap_reached'`

`recordCapReachedOrUnhealedDefer` writes ONE row per build whose `reconcileFailingGrepChecksForSpec` returned an unreconciled list (whether from `cap_reached`, `judge_declined`, `proposal_did_not_match`, `no_normalized_match`, `not_present_grep`, or a DB write failure). Preserves the real-failure path: the build STILL defers via the existing `finalizeBuiltPhase` defer branch, and the redrive reason carries the unhealed preview so a `redriveDeferredBuildOrEscalate` cap-exhaustion escalates with the ACTUAL failing check descriptions.

- `action_kind`: `'check_reconcile_cap_reached'`.
- `reason`: `phase-verify reconciler: N auto-corrected, M un-reconcilable (cap=X, cap_reached=Y) — deferring build with real-failure list preserved. First: <preview>`.
- `metadata`: `{ job_id, spec_slug, cap, reconciled_count, cap_reached, unreconciled: [{ phase_id, phase_position, check_position, description, old_pattern, reason, evidence }], autonomous: true }`.

**Log-tail mirror.** The worker's `finalizeBuiltPhase` also carries the unhealed preview into the deferred build's `log_tail` (via `reconcileUnhealedListForDefer`) so a reader who's inspecting the `agent_jobs` row (not the director feed) still sees why the phase couldn't heal. Both surfaces show the SAME list — no split-brain.

### Guarantees

- **Never silent.** Every successful repair emits a `check_reconciled` row (via the default hook on `defaultBatchDeps`). Every defer with un-healed checks emits a `check_reconcile_cap_reached` row.
- **Real-failure path preserved.** The cap-reached case does NOT force a pass. The unhealed checks still fail their deterministic grep → `isSpecAccumulationComplete` still reports `complete=false` → the defer/escalate branch fires as before, just with the unhealed list surfaced through both the log_tail and the director-activity row.
- **Best-effort.** A director-activity write failure never blocks the reconciliation or the build; a warning is logged and the flow continues.

## North star

The reconciler is a bounded proxy (make the pattern match reality); the deterministic grep still owns the objective (is the code actually present). Same shape as every other autonomous tool per [[../operational-rules]] § North star — the tool PROPOSES, a deterministic check CONFIRMS. A judge that fabricates a literal is caught by the final grep and never lands. And the CEO — the ultimate objective-owner — sees every auto-correction via the audit rows above, so the reconciler cannot silently drift.

## Related

[[spec-check-runner]] · [[spec-phase-checks-table]] · [[specs-table]] · [[builder-worker]] · [[director-activity]] · [[../tables/director_activity]] · [[ai-models]] · [[../specs/build-verify-self-heals-stale-grep-checks-before-deferring]] · [[../specs/merge-gate-verifies-real-phase-checks-not-status-flags]] · [[../operational-rules]]
