# libraries/spec-phase-checks-executable

Executable payload on [[../tables/spec_phase_checks]] read by the deterministic Node spec-check runner ([[../specs/machine-declared-verification-and-deterministic-spec-test-runner]] Phase 1). Turns each verification bullet from prose Vera must interpret into a typed, runnable object a plain Node module executes on the box — no LLM, no flake — reserving the Max session for only the genuinely-human residual (drift, subjective bullets, undeclared prose).

**File:** `src/lib/spec-phase-checks-table.ts` (exports `SpecPhaseCheckExecKind`, `validateExecutableCheck`, `isPlainReadonlySql`, `AUTO_TESTABLE_EXEC_KINDS`)

## The two columns

Added by `supabase/migrations/20261013120000_spec_phase_check_executable.sql`:

| Column | Type | Notes |
|---|---|---|
| `exec_kind` | `text` (CHECK-constrained) | The RUNNABLE kind — `tsc` · `grep` · `ci_status` · `http_get` · `db_probe_readonly` · `unit_test` · `build` · `needs_human`. Nullable during the migration window (a null row is treated as `needs_human` by the runner). |
| `params` | `jsonb` | The typed params per exec_kind. Shape enforced app-layer by `validateExecutableCheck` (no Postgres jsonb schema constraint). Nullable — `tsc` / `build` / `ci_status` / `needs_human` carry `null`. |

Coexists with the coarse [[spec-phase-checks-table]] `kind` column (`auto` | `human`) — `kind` stays the display/chip category; `exec_kind` decides EXECUTION.

## Kinds + param shapes

| exec_kind | params | What the runner (Phase 2) will do |
|---|---|---|
| `tsc` | `null` | `npx tsc --noEmit` in the repo root. Pass ⇔ clean. |
| `grep` | `{ pattern, path?, expect: 'present'|'absent' }` | Ripgrep `pattern` under `path` (repo root default). Pass ⇔ match presence matches `expect`. |
| `ci_status` | `null` | `gh run` / `gh pr checks` for the branch. Pass ⇔ green. |
| `http_get` | `{ url, expect_status }` | `fetch(url)`. Pass ⇔ response status equals `expect_status`. |
| `db_probe_readonly` | `{ sql, expect }` | Run `sql` via the pooled admin client. `sql` MUST pass `isPlainReadonlySql` (plain `SELECT` / `WITH`, no chained statements, no mutating verbs). Pass ⇔ rows deep-equal `expect`. |
| `unit_test` | `{ script }` | `npm run {script}` in the repo root. `script` MUST be a real key of `package.json.scripts` (rejected at authoring, not runtime). Pass ⇔ exit 0. |
| `build` | `null` | `next build`. Pass ⇔ exit 0. |
| `needs_human` | `null` | NEVER auto-run. Reserved for drift / subjective / undeclared prose — routed to the LLM residual. |

`AUTO_TESTABLE_EXEC_KINDS` is the frozen array of everything the runner MAY execute (all of the above except `needs_human`).

## validateExecutableCheck

`validateExecutableCheck(check, { packageScripts? })` → `{ valid: true } | { valid: false, reason }`.

Pure predicate — no I/O. Runs at the authoring chokepoint so an untypable check never lands as `exec_kind !== 'needs_human'`. Enforces the rules above; passing a `packageScripts` set opts into the `unit_test.script` existence check (this closes the cs-director `npm test` class at authoring — a script name absent from `package.json` rejects here, not silently at Vera time).

`isPlainReadonlySql(sql)` — the read-only-SQL guard used by `db_probe_readonly`. Trims + accepts `SELECT` / `WITH` starts; rejects any chained statement (`;` followed by non-whitespace) and any mutating verb / DDL as a whole word (`insert`/`update`/`delete`/`drop`/`alter`/`truncate`/`create`/`grant`/`revoke`/`lock`/`copy`/`merge`/`do`/`call`/`reindex`/`vacuum`/`analyze`/`refresh`/`comment`). Substring-based on purpose — a false positive fails CLOSED into `needs_human`, the safe direction.

## Wired into Vera's box lane

Phase 3 wired [[spec-check-runner]] `runSpecChecks` into `runSpecTestJob` (`scripts/builder-worker.ts`). Every post-ship spec-test job now runs the deterministic runner FIRST and skips the Max session entirely when every check resolves without a `needs_human` residual — a spec whose verification is fully machine-declared verifies with ZERO Max cost. See [[spec-test-runs]] § Deterministic pre-pass for the full lifecycle.

## Prose is never auto-run

[[spec-phase-checks-table]] `parseVerificationBlobToChecks` stamps `exec_kind: 'needs_human'` on every derived row. Only the structured author path (`checks: [{ exec_kind, params }]`) can opt a check into deterministic execution — the runner ignores anything else. Un-typed prose falls through to the LLM residual, which is the exact safe default that closes the class of "Vera mis-runs a made-up command" (the 2026-07-11 cs-director false regression) the spec cites in § Why.

## Related

[[spec-phase-checks-table]] · [[../tables/spec_phase_checks]] · [[../specs/machine-declared-verification-and-deterministic-spec-test-runner]] · [[../specs/spec-test-agent]] · [[author-spec]]
