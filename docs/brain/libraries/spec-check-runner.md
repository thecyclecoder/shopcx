# libraries/spec-check-runner

Deterministic Node runner over a spec's [[../tables/spec_phase_checks]] rows ([[../specs/machine-declared-verification-and-deterministic-spec-test-runner]] Phase 2). Turns the machine-declared verification subset from prose the LLM must interpret into plain code the box executes — instant, free, flake-free — so Phase 3's Vera lane can reserve a Max session for ONLY the genuinely-human residual (drift · subjective · undeclared prose).

**File:** `src/lib/spec-check-runner.ts` — exports `runSpecChecks`, `defaultExecutors`, `defaultLoadChecks`, and the `LoadedCheck` / `CheckResult` / `CheckExecutors` types.

## Contract

```ts
runSpecChecks({ workspaceId, slug, deps }) → { workspaceId, slug, results: CheckResult[] }

interface CheckResult {
  text: string;               // the check's description
  checkKey: string;           // stable hash via [[spec-test-runs]] `checkKey(text)`
  verdict: 'pass' | 'fail' | 'needs_human';
  category: 'auto' | 'needs_human';
  evidence: string;           // human-readable execution proof
  exec_kind: SpecPhaseCheckExecKind | null;
}
```

The result shape matches [[spec-test-runs]] `SpecTestCheck` exactly (`text`, `verdict`, `category`, `evidence`), so Phase 3's `runSpecTestJob` can write the runner's output straight into `spec_test_runs.checks` — no shim, no re-mapping.

## The four invariants

1. **No LLM call.** The module has no `anthropic` import. `grep -rn 'anthropic\\|@anthropic-ai' src/lib/spec-check-runner.ts` returns 0 non-comment matches. A spec whose checks are all auto-testable + machine-declared verifies with ZERO Max cost.
2. **Non-destructive by construction.** Only `AUTO_TESTABLE_EXEC_KINDS` (from [[spec-phase-checks-executable]]) executes. Anything else — a mutating SQL (rejected by `isPlainReadonlySql`), an undeclared prose row (`exec_kind` null), an explicit `needs_human`, an unknown script (`unit_test.script` not in `package.json`), an invalid params shape — resolves to `needs_human` with the reason in `evidence`. The executor is NEVER called for a rejected check.
3. **Harness error ≠ fail.** A check that never actually ran an assertion (spawn ENOENT · command-not-found · `npm error Missing script` · fetch spawn error) is a broken bullet, not a code regression. [[spec-test-harness-classifier]] `isHarnessCommandFailure` re-routes any such would-be `fail` to `needs_human` with `harness error (bullet broken, not code): …` prefixed onto the evidence — the exact 2026-07-11 cs-director class the spec cites in § Why, now structural.
4. **Deterministic.** Same input rows + same injected executors → byte-identical `results`. There is NO random id and NO wall-clock timestamp inside a per-check result. The unit test (`src/lib/spec-check-runner.test.ts` — "byte-identical reruns") pins this.

## Executors + DI

Per `exec_kind` the runner delegates to one method of the injected `CheckExecutors` object. `defaultExecutors` is the real-tool wiring:

| exec_kind | Default executor |
|---|---|
| `tsc` | `npx tsc --noEmit` in `repoRoot` |
| `grep` | `rg -e <pattern> <path>` — exit 0 → present, exit 1 → absent, else harness error |
| `ci_status` | `gh pr checks` in `repoRoot` |
| `http_get` | `fetch(url)` — status compared to `expect_status` |
| `db_probe_readonly` | belt-and-suspenders `isPlainReadonlySql` guard, then `admin.rpc('exec_readonly_sql', { sql_text })` and deep-equal the result to `params.expect` |
| `unit_test` | reads `package.json.scripts`, spawns `npm run <script>` (emits a harness-classifier-matching signature when `script` is absent — the same rail the app-layer validator uses at authoring) |
| `build` | `npx next build` in `repoRoot` |

Every executor returns `{ ok, evidence }`; the runner turns `ok` into `verdict` and adds the harness-error downgrade. Tests inject deterministic doubles.

## Row loader

`defaultLoadChecks(workspaceId, slug)` reads the spec's `spec_phase_checks` rows in phase + position order via the [[specs-table]] `getSpec` accessor — the same order the LLM lane sees today, so the `checkKey → verdict` mapping stays stable across Phase-2 / Phase-3 wiring.

## Why deterministic + non-destructive here (and not in the LLM)

Once each check declares HOW to run it, "verification" is mechanical: a type-check, a grep, a CI status, a read-only DB probe, a GET, a named unit-test, a build. Reserving the LLM only for what CAN'T be declared (subjective / drift / prose) — the residual routed to `needs_human` — is the same crystallize-the-mechanical move [[operational-rules]] § North star names for every autonomous tool: bound the proxy, own the objective. A deterministic runner IS the bounded proxy; the LLM residual IS the human judgment.

## Phase 3 wiring — how the box calls the runner

`scripts/builder-worker.ts` `runSpecTestJob` invokes `runSpecChecks` in-process BEFORE spawning any Max session and calls `classifyDeterministicRun(results)` on the return. On the post-ship path (NOT a fused pre-merge job), `allResolved === true` means the row is written straight from the runner's verdicts and the LLM lane is skipped entirely. Otherwise, the Max session is spawned with a `residualTexts` scope hint, and `mergeDeterministicWithLlmChecks` fuses the runner's authoritative pass/fail with the LLM's residual on return. Every invocation beats the Control Tower loop `DETERMINISTIC_SPEC_CHECK_RUNNER_LOOP_ID` (ok:true when the runner returned, ok:false when it threw and Vera took over) — the "monitored, not graded" liveness assertion the [[agent-grader]] carve-out on `spec-test` + null `claude_session_id` pairs with.

## Related

[[spec-phase-checks-executable]] · [[spec-phase-checks-table]] · [[spec-test-runs]] · [[spec-test-harness-classifier]] · [[../specs/machine-declared-verification-and-deterministic-spec-test-runner]] · [[../specs/spec-test-agent]]
