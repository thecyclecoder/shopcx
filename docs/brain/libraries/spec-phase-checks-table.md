# libraries/spec-phase-checks-table

SDK writer/reader for [[../tables/spec_phase_checks]] ([[../specs/pm-structured-intent-and-refs]] Phase 3), the structured replacement for the free-text `spec_phases.verification` blob.

**File:** `src/lib/spec-phase-checks-table.ts`

## Rows are the render source of truth

The typed `spec_phase_checks` rows — NOT the `spec_phases.verification` TEXT column — are now the source of truth for a spec's verification. [[build-spec-materializer]] `renderSpecRow` synthesizes each phase's `### Verification` markdown FROM these rows (one `- {description}` bullet per check) via the `checksByPhaseIdForRender` map below, falling back to the `verification` column only for a phase that has no rows (the transitional fallback). This is the founder invariant "a render can take DB items and add markdown; don't store markdown elements in the DB as data objects" — the DB holds typed check objects; the markdown is a render-time artifact. Proven `checkKey`-stable across all 928 phases (`scripts/_prove-checkkey-stable-render-flip.ts`, 0 drift), so Vera / Vale / Bo see semantically identical verification.

## Exports

- **`upsertPhaseChecks(phase_id, checks[])`** → `Promise<void>` — REPLACE-by-position writer. Matching positions UPDATE in place (stable id), new positions INSERT, vanished positions DELETE. Idempotent. Called by [[author-spec]] `authorSpecRowStructured` for every phase after `upsertSpec` returns the `phase_ids` map.
- **`listPhaseChecks(phase_id)`** → `Promise<SpecPhaseCheckRow[]>` — ordered by position.
- **`checksByPhaseIdForRender(phaseIds[])`** → `Promise<Map<phase_id, { description }[]>>` — the batched render-source reader. Fetches every check for the given phase ids in ONE query and returns a `spec_phases.id → [{ description }]` map in position order — the exact shape [[build-spec-materializer]] `renderSpecRow(row, checksByPhaseId?)` consumes to synthesize `### Verification` bullets. `materializeSpec` calls it with the spec's phase ids and passes the map to `renderSpecRow`. A phase absent from the map (no rows) falls back to its `spec_phases.verification` column.
- **`parseVerificationBlobToChecks(blob)`** → `SpecPhaseCheckInput[]` — best-effort split of a free-text verification blob into per-check rows. Splits on `-` / `*` bullet lines; a non-bullet paragraph becomes ONE check. Used by [[author-spec]] to derive `checks` when the caller doesn't pass an explicit array — same rail as the free-text `verification` gate, one layer up.

## Kinds

- **`auto`** — the spec-test agent (or the deterministic runner, if machine-declared) runs this check directly (non-destructive: `tsc`, gh CI status, Vercel deploy, GET endpoints, read-only DB probes, code imports). Default.
- **`human`** — parked needs_human. The check requires a human verifier (visual/UX, prod-mutating, out-of-box observation).

## Machine-declared executable checks

[[../specs/machine-declared-verification-and-deterministic-spec-test-runner]] Phase 1 extends each row with an executable payload — `exec_kind` + typed `params` — so the deterministic spec-check runner (Phase 2) executes the auto-testable subset with NO LLM. A check declares its kind (tsc · grep · ci_status · http_get · db_probe_readonly · unit_test · build · needs_human) and provides shaped params; [[spec-phase-checks-executable]] documents the schema; [[../tables/spec_phase_checks]] lists the new columns.

`validateExecutableCheck` (exported by this module) enforces the typed params shape before DB write: grep needs `{pattern, path?, expect}`, http_get needs `{url, expect_status}`, db_probe_readonly names a probe from the [[spec-check-db-probes]] registry, unit_test names a real package.json script. A check with no exec_kind or with exec_kind='needs_human' never auto-runs — safe default during the prose→executable migration window.

### Grep path security: validateGrepPath

Grep checks treat `params.path` as a spec-authored capability boundary. `validateGrepPath` (co-exported, called by `validateExecutableCheck` for every grep check) rejects paths that are absolute, empty, NUL-embedded, traverse outside the repo with `..` segments, or start with `'-'` (would be parsed as an option/preprocessor by ripgrep). The runner also passes the value after an argv `--` separator (see [[spec-check-runner]] `defaultExecutors.grep`), but this validator is the primary gate: a rejected path never reaches spawn at all.

## Author chokepoint gate

Two gates fire in order BEFORE the DB write; both throw with the offending phase named so the author sees exactly what's un-testable:

1. [[author-spec]] `assertEveryPhaseHasChecks` throws `MissingVerificationError` if any phase yields zero checks — a totally-empty phase never lands.
2. [[author-spec]] `assertEveryPhaseHasMachineCheck` — [[../specs/every-spec-writer-authors-machine-runnable-verifications]] Phase 1 — throws `MissingMachineCheckError` if any phase's checks are ALL prose / ALL `needs_human`. Every phase must carry ≥1 check with a valid `exec_kind` (tsc | grep | ci_status | http_get | db_probe_readonly | unit_test | build) that passes `validateExecutableCheck`. Machine-runnable is the sole ship gate; `needs_human` rows are legal only as EXTRA advisory checks alongside a real machine one. Applies to both author entry points (structured + markdown) so every writer (planner, spec-chat, ~17 box-worker author lanes, request-fix) inherits it — no writer can land a prose-only spec.

## Optional, non-blocking `human_review` (Phase 2)

`public.specs.human_review` (additive migration 20261014120000) carries an OPTIONAL, non-blocking founder-facing advisory note — "after ship, open /dashboard/x and confirm the layout reads right." Threaded through both author entry points ([[author-spec]] `authorSpecRowStructured.spec.human_review` / `AuthorSpecOpts.humanReview`; `authorSpecRowFromMarkdown` `extractHumanReviewHeader`). Rendered on the spec card + post-ship founder surface. NEVER read by the fold gate, promote gate, or deterministic spec-check runner — machine-runnable `spec_phase_checks` remain the sole ship gate. Absence is the norm.

## Phase 3 — backfill existing prose to typed

`scripts/backfill-spec-checks-to-typed.ts` — safety-first prose→typed classifier (dry-run/`--apply`, compare-and-set write with `.eq('exec_kind','needs_human')` guard so a re-run never clobbers a subsequent SDK-set typed row). Promotes literal-command bullets (tsc / build / ci_status / http_get / unit_test with a real `package.json` script) to their typed exec_kind; grep and db_probe_readonly are DELIBERATELY NOT auto-derived (fabrication risk). Unmappable prose stays `needs_human` — the safe direction. Pinned by 18 unit tests in `scripts/backfill-spec-checks-to-typed.test.ts`.

## Related

[[../tables/spec_phase_checks]] · [[build-spec-materializer]] · [[specs-table]] · [[author-spec]] · [[spec-phase-checks-executable]] · [[spec-check-runner]] · [[../specs/machine-declared-verification-and-deterministic-spec-test-runner]] · [[../specs/pm-structured-intent-and-refs]]
