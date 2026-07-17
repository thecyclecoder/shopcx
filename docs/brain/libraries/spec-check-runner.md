# libraries/spec-check-runner

Deterministic Node runner over a spec's [[../tables/spec_phase_checks]] rows ([[../specs/machine-declared-verification-and-deterministic-spec-test-runner]] Phase 2). Turns the machine-declared verification into plain code the box executes — instant, free, flake-free.

> **⭐ graduate-vera (2026-07-17): this runner IS the spec-test verdict. Vera is RETIRED.** The spec-test job (`runSpecTestJob` in [[../../../scripts/builder-worker]]) NO LONGER spawns a Vera Max session. It runs `runSpecChecks` and writes the runner's `agentVerdict`/`summary`/`checks` straight to [[../tables/spec_test_runs]] — post-ship AND pre-merge. A residual (non-machine) bullet the runner can't execute stays `needs_human` (surfaced, never AI-judged — the submission/review gates make a prose verification near-impossible, and a mis-authored *pattern* is a broken check caught by [[spec-test-harness-classifier]]). A runner **exception** is a HARNESS error → a re-runnable `error` run, never a false `fail`. **Pre-merge runs against a branch worktree:** the code under test is on the `claude/build-*` branch, not main, so the box checks out `origin/<branch>` into a read-only `git worktree add --detach` (symlinked node_modules) and passes it as `repoRoot` — a grep/tsc against main would under-see branch-only code. **Security is Vault's own solo session** now — `runSpecTestJob` enqueues a standalone branch-mode `security-review` ([[security-agent]] `enqueueSecurityReviewJob`) on completion; the fused spec-test+security session is gone.

**File:** `src/lib/spec-check-runner.ts` — exports `runSpecChecks`, `defaultExecutors`, `defaultLoadChecks`, `redirectUrlToPreview`, and the `LoadedCheck` / `CheckResult` / `CheckExecutors` types.

> **`http_get` preview-redirect (graduate-vera):** `runSpecChecks` accepts `deps.previewOrigin`. When set (a pre-merge run), the `http_get` executor rewrites a `shopcx.ai` target URL to the per-build preview origin via `redirectUrlToPreview` (path + query preserved; external / relative URLs untouched) — so an endpoint check hits THIS branch's preview, not prod (the branch's code isn't on prod yet). Post-ship runs pass `previewOrigin: null` → no redirect. `runSpecTestJob` passes `isPreMerge ? previewOrigin : null`.

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
| `grep` | `rg -e <pattern> -- <path>` — validated path passed after `--` separator to prevent option injection. Exit 0 → present, exit 1 → absent, else harness error. Path validation is enforced by [[spec-phase-checks-table]] `validateGrepPath` at authoring time; the `--` separator is defense-in-depth. |
| `ci_status` | `gh pr checks` in `repoRoot` |
| `http_get` | `fetch(url)` — status compared to `expect_status` |
| `db_probe_readonly` | looks up `params.probe_id` in [[spec-check-db-probes]] `DB_PROBES`, invokes the fixed shaped query with `params.args`, and deep-equals the returned scalar to `params.expect`. Evidence is the probe's REDACTED string (probe id + scalar) — NEVER a row body. Free-form SQL is not accepted; this closes the 5 pre-merge Vault findings on the old `exec_readonly_sql` path (injection · secret_leak · authz_rls · unsafe_admin_client · crypto_encrypted). |
| `unit_test` | reads `package.json.scripts`, spawns `npm run <script>` (emits a harness-classifier-matching signature when `script` is absent — the same rail the app-layer validator uses at authoring) |
| `build` | `npx next build` in `repoRoot` |

Every executor returns `{ ok, evidence }`; the runner turns `ok` into `verdict` and adds the harness-error downgrade. Tests inject deterministic doubles.

## Row loader

`defaultLoadChecks(workspaceId, slug)` reads the spec's `spec_phase_checks` rows in phase + position order via the [[specs-table]] `getSpec` accessor — the same order the LLM lane sees today, so the `checkKey → verdict` mapping stays stable across Phase-2 / Phase-3 wiring.

## Why deterministic + non-destructive here (and not in the LLM)

Once each check declares HOW to run it, "verification" is mechanical: a type-check, a grep, a CI status, a read-only DB probe, a GET, a named unit-test, a build. Reserving the LLM only for what CAN'T be declared (subjective / drift / prose) — the residual routed to `needs_human` — is the same crystallize-the-mechanical move [[operational-rules]] § North star names for every autonomous tool: bound the proxy, own the objective. A deterministic runner IS the bounded proxy; the LLM residual IS the human judgment.

## Phase 3 wiring — how the box calls the runner

> **⭐ no-machine-checks-auto-pass (CEO 2026-07-17):** `classifyDeterministicRun` returns `approved` when there are **no machine/auto checks at all** (`auto_pass + auto_fail === 0`) — the deterministic runner can only gate on what it can mechanically run, so a spec with nothing to verify AUTO-PASSES rather than stranding on `needs_human`. Before this, the verdict required `auto_pass > 0` to approve, so a spec with zero machine-declared checks fell through to `needs_human` — and since the auto-merge requires a **green** spec-test, that spec could NEVER self-merge (it always needed a manual merge; the 2026-07-17 winners-flow stall). A `fail` still wins (`issues`); a genuine residual on a spec that DOES run machine checks still surfaces (`needs_human`); human sign-off is the separate optional human-test column, never a reason for the machine gate to block ([[operational-rules]] § no-human-checks-in-verifications). Pinned by the zero-checks + only-needs_human + fail-still-wins cases in `src/lib/spec-check-runner.test.ts`.

`scripts/builder-worker.ts` `runSpecTestJob` invokes `runSpecChecks` in-process BEFORE spawning any Max session and calls `classifyDeterministicRun(results)` on the return. On the post-ship path (NOT a fused pre-merge job), `allResolved === true` means the row is written straight from the runner's verdicts and the LLM lane is skipped entirely. Otherwise, the Max session is spawned with a `residualTexts` scope hint, and `mergeDeterministicWithLlmChecks` fuses the runner's authoritative pass/fail with the LLM's residual on return. Every invocation beats the Control Tower loop `DETERMINISTIC_SPEC_CHECK_RUNNER_LOOP_ID` (ok:true when the runner returned, ok:false when it threw and Vera took over) — the "monitored, not graded" liveness assertion the [[agent-grader]] carve-out on `spec-test` + null `claude_session_id` pairs with.

## Pre-commit self-verify (build lane) — the second caller

The build lane calls the runner too, at a different chokepoint: `scripts/builder-worker.ts` `preCommitSelfVerify` ([[builder-worker]] § Pre-commit self-verify gate) runs `runSpecChecks` against Bo's WORKTREE right after tsc + `check:table-refs-have-migrations` and BEFORE `git commit`. Same runner, same defaults; the only two differences are (1) `deps.repoRoot` is the build worktree `wt`, not `REPO_DIR`, so grep/tsc/unit_test/build reflect Bo's uncommitted edits, and (2) results are filtered to `SELF_VERIFY_WORKTREE_KINDS = { grep, tsc, unit_test, build }` BEFORE `classifyDeterministicRun` — the blocking decision cannot be driven by a `db_probe_readonly` / `ci_status` / `http_get` check that legitimately can't yet exist pre-commit. On a real block (`auto_fail > 0` over the filtered set), the build lane resumes Bo for up to `SELF_VERIFY_REPAIR_MAX` in-session repair passes; cap exhaustion fails the job and the existing fix-phase self-heal picks it up.

## Related

[[spec-phase-checks-executable]] · [[spec-phase-checks-table]] · [[spec-check-db-probes]] · [[spec-test-runs]] · [[spec-test-harness-classifier]] · [[builder-worker]] · [[../specs/machine-declared-verification-and-deterministic-spec-test-runner]] · [[../specs/spec-test-agent]]
