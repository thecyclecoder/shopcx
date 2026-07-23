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

### Step B — bounded intent judge (only if A misses)

Reads:
- The check's `description` — the INTENT the author wrote in prose (e.g. "reconciler defined").
- The phase's branch DIFF for `params.path`, bounded to 16 KB via `git diff origin/main...<branchRef> -- <path>`.

Asks Claude Sonnet (`SONNET_MODEL` from [[ai-models]]) to decide whether the diff satisfies the described intent under a DIFFERENT literal and, if so, return the EXACT literal present in the diff. Strict-JSON output: `{literal: string|null, rationale: string}`. Max 400 output tokens. Fail-closed on any API / parse error → `literal: null`, no reconcile.

The judge NEVER decides the phase passes. It only PROPOSES a literal. The proposed literal is then run through the runner's real deterministic ripgrep — a fabricated literal that isn't on the branch is caught by the final grep and never reconciles.

## Invariants

1. **`expect: 'present'` ONLY.** An `expect: 'absent'` miss is a different, real signal (the code SHOULDN'T be there and IS) — never reconciled.
2. **A repointed pattern MUST pass a real deterministic grep before the phase is treated as reconciled.** The final gate stays a real grep of the corrected pattern — no bypass, no phantom-ship. Both step A and step B route their proposal through `defaultRunDeterministicGrep` (identical argv to the runner's `defaultExecutors.grep`).
3. **The judge NEVER decides pass/fail — it only PROPOSES a literal.** The deterministic grep of that proposal is the final gate.
4. **Capped per build.** `reconcileFailingGrepChecksForSpec` accepts `maxReconciliationsPerBuild` (default: total grep-check count in the spec). Exceeded → any remaining unhealed checks report `cap_reached` and the caller defers as before.
5. **Every reconciliation is surfaced — never silent.** Phase 1 logs each repair to the run log tail (`check-reconciled: phase N check 'D' (step): 'old' → 'new' — rationale`); Phase 2 wires the same audit hook to the build-card surface so the CEO sees what was auto-corrected.
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
  → { reconciled: true, newPattern, step: 'normalized_case' | 'judge_proposal', rationale, evidence }
  | { reconciled: false, reason, evidence? }

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

## North star

The reconciler is a bounded proxy (make the pattern match reality); the deterministic grep still owns the objective (is the code actually present). Same shape as every other autonomous tool per [[../operational-rules]] § North star — the tool PROPOSES, a deterministic check CONFIRMS. A judge that fabricates a literal is caught by the final grep and never lands.

## Related

[[spec-check-runner]] · [[spec-phase-checks-table]] · [[specs-table]] · [[builder-worker]] · [[ai-models]] · [[../specs/build-verify-self-heals-stale-grep-checks-before-deferring]] · [[../specs/merge-gate-verifies-real-phase-checks-not-status-flags]] · [[../operational-rules]]
