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

Asks Claude Sonnet (`SONNET_MODEL` from [[ai-models]]) to decide whether the diff satisfies the described intent under a DIFFERENT literal and, if so, return the EXACT literal present in the diff. Strict-JSON output: `{literal: string|null, rationale: string}`. Max 400 output tokens. Fail-closed on any API / parse error → `literal: null`.

**SECURITY — the judge NEVER auto-reconciles.** The judge reads the UNTRUSTED branch diff, so a prompt-injection comment in that diff could steer it to an unrelated-but-present literal; a deterministic grep of that literal only proves it EXISTS, not that it satisfies the check's intent. So step B is **advisory only**: a judge proposal is recorded as an UNRECONCILED, human-review diagnostic (`reconciled: false, reason: 'judge_proposal_needs_human'`, with the candidate literal + `present-on-branch=<bool>` in `evidence`). The caller defers/escalates exactly as for any un-healed check — a real code-missing signal is never masked, and a human decides whether to repoint the pattern by hand. **Only step A (deterministic normalized re-match) auto-heals.** (Security review of `build-verify-self-heals-stale-grep-checks-before-deferring`, 2026-07-23.)

## Invariants

1. **`expect: 'present'` ONLY.** An `expect: 'absent'` miss is a different, real signal (the code SHOULDN'T be there and IS) — never reconciled.
2. **Only step A (deterministic normalized re-match) auto-reconciles, and its repointed pattern MUST still pass a real deterministic grep** (`defaultRunDeterministicGrep`, identical argv to the runner's `defaultExecutors.grep`) — no bypass, no phantom-ship. The LLM judge never clears a check.
3. **The judge NEVER decides pass/fail and NEVER auto-reconciles — it only surfaces a candidate literal for a human to review.** (Prompt-injection guard — see Step B above.)
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
  → { reconciled: true, newPattern, step: 'normalized_case', rationale, evidence }  // step B never auto-reconciles
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

## Audit surface — never silent ([[../specs/build-verify-self-heals-stale-grep-checks-before-deferring]] Phase 2)

A self-healing check that isn't visible is a proxy that optimizes itself — the exact "silent proxy-optimizer" the [[../operational-rules]] § North star forbids. Every reconciliation MUST land on the CEO-facing build-card feed so an auto-correction can be eyeballed, and a mis-guessed spec can't hide behind the reconciler.

### Per-repair row — `director_activity.action_kind='check_reconciled'`

`defaultAuditReconciliation` in `src/lib/build/check-reconciliation.ts` is the default `auditReconciliation` dep on `defaultBatchDeps`. It writes ONE [[../tables/director_activity]] row per successful repair via [[director-activity]] `recordDirectorActivity`:

- `director_function`: `'platform'` (Ada's feed).
- `action_kind`: `'check_reconciled'` (a new vocabulary entry on `DirectorActionKind` — see [[director-activity]]).
- `spec_slug`: the spec whose check was repointed.
- `reason`: one line — `phase N check '<description>' auto-corrected via <step>: 'old' → 'new' — <rationale>`.
- `metadata`: `{ spec_slug, phase_id, phase_position, check_position, check_description, old_pattern, new_pattern, step: 'normalized_case' | 'judge_proposal', rationale, evidence, autonomous: true }`.

Best-effort + never throws — a director-activity blip is worse than the gap it records. The row is what the EOD recap, Ada's activity feed, and the #directors board post read.

### Cap-reached / defer-with-unhealed row — `director_activity.action_kind='check_reconcile_cap_reached'`

`recordCapReachedOrUnhealedDefer` writes ONE row per build whose `reconcileFailingGrepChecksForSpec` returned an unreconciled list (whether from `cap_reached`, `judge_declined`, `no_normalized_match`, `not_present_grep`, or a DB write failure). Preserves the real-failure path: the build STILL defers via the existing `finalizeBuiltPhase` defer branch, and the redrive reason carries the unhealed preview so a `redriveDeferredBuildOrEscalate` cap-exhaustion escalates with the ACTUAL failing check descriptions.

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
