# libraries/ship-time-backfill-executor

Closes the loop the [[ship-time-backfill-detector]] opens. The detector ledgers every shipped `scripts/_backfill-*.ts` as a `pending` [[../tables/data_op_runs]] row and escalates it to the CEO inbox (VISIBLE but un-run). This module DRAINS those rows on the box — spawns each script once, captures the outcome, and flips the row to `ran` / `failed` with a compare-and-set.

**File:** `src/lib/ship-time-backfill-executor.ts` · runs on the box's post-merge on-box pass (mirrors where [[control-tower/migration-drift|applyMergedMigrations]] runs). BOX-ONLY — the deployed Next runtime has neither the `tsx` binary nor the repo working tree.

## North star — run the data-op for real, never a phantom success

The executor's degenerate state is marking a row `ran` when nothing wrote. That exact bug shipped: `spawnBackfill` spawned `npx tsx -- <script>` with NO `--apply`, but 42 of 55 backfill scripts on main are **dry-run by default** (`const APPLY = process.argv.includes("--apply") || process.env.APPLY === "1"`). So the executor dry-ran them and the ledger recorded `ran` though prod was untouched — ~14 APPLY-gated rows marked `ran` this way. [[../specs/ship-time-backfill-executor-passes-apply]] Phase 1 fixed it via `buildBackfillArgv` + `buildBackfillEnv` + `isDryRunStdout` detection.

## Exports

- `executeShipTimeBackfillsForSpec({ workspaceId, specSlug, repoDir, execTimeoutMs? })` — the one-shot drain. Reads every `pending` `data_op_runs` row for the spec, validates each `script_path` as an untrusted capability boundary, spawns it in WRITE mode, and writes `ran` / `failed` back with a compare-and-set. Returns a `ShipTimeBackfillExecutionSummary` (`pending`, `ran`, `failed`, `rejected`, `raced`). Best-effort — never throws.
- `isValidScriptPathForExec(path)` — second-line capability gate before `spawn`: the bounded `isBackfillScriptPath` regex (which now also rejects `*.test.ts` / `*.spec.ts`), no absolute path, no `..` traversal, no leading `-` option-lookalike.
- `buildBackfillArgv(scriptPath)` — pure: `["tsx", "--", scriptPath, "--apply"]`. The `--` separator keeps tsx from parsing the path as a flag; `--apply` is LAST and forces write mode. Unit-tested so the APPLY contract can't silently regress.
- `buildBackfillEnv(base?)` — pure: `{ ...base, APPLY: "1" }`. Belt to the `--apply` flag's braces — a script keyed on the env var instead of (or as well as) argv still runs in write mode.
- `isDryRunStdout(stdout)` — pure: `/dry-run/i.test(stdout)`. Belt-and-braces no-op detector (see below).

## Guardrails / invariants

- **RUNS IN WRITE MODE.** `spawnBackfill` passes BOTH `--apply` on argv (`buildBackfillArgv`) AND `APPLY=1` in the child env (`buildBackfillEnv`). A script keyed on either writes; a script that always writes ignores both.
- **DRY-RUN STDOUT ⇒ `failed`.** Even on a clean `exit 0`, if the child's stdout announces a `DRY-RUN` / `dry-run` banner (`isDryRunStdout`), the row is recorded `failed` with error `ran in dry-run mode` — a future script with a different flag name can't silently no-op as `ran`.
- **CAPABILITY BOUNDARY.** The `script_path` is a spec-authored field ledgered from a merged diff — treat it as untrusted. Two rails: `isValidScriptPathForExec` (bounded regex + no `-`/absolute/`..`) and the array-argv `spawn` with an explicit `--` separator (never a shell string).
- **COMPARE-AND-SET WRITES.** Every `ran` / `failed` flip is `.eq('id',…).eq('workspace_id',…).eq('status','pending').select('id')` so a concurrent pass can't overwrite a status the other just set (a 0-row match is counted `raced`, never double-executed).
- **NEVER THROWS / BOX-ONLY.** Wrapped in try/catch; invoked only from the box's on-box pass, never the deployed webhook path.

## Related

[[ship-time-backfill-detector]] (the sibling that ledgers + escalates) · [[../tables/data_op_runs]] (the ledger it drains) · [[control-tower/migration-drift]] (`applyMergedMigrations` — the migration analogue of this box-side drain) · [[../specs/ship-time-backfill-executor-passes-apply]] · [[../operational-rules]] (§ North star — run the data-op for real)
