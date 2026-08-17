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

### Builder-chosen-name reject: detectBuilderChosenNameInGrep

[[../specs/a-verification-check-must-not-demand-a-name-the-builder-has-to-guess]] Phase 1 — `validateExecutableCheck` rejects a `grep` whose `pattern` pins an exact literal for a name the IMPLEMENTATION gets to invent (an npm script name, a `*.test.ts` filename, a kebab-case slug, a camelCase symbol) when the spec body does not itself pin that name. Fires at the author chokepoint only — [[author-spec]] `assertEveryPhaseHasMachineCheck` threads a per-phase `specText` (spec-level why+what + phase title/why/what/body for the structured path, whole markdown for the markdown path) so a literal named anywhere in the spec is spec-pinned and passes. A caller that omits `specText` (the [[spec-check-runner]] runtime path) is unchanged — the guard never retroactively fails an already-authored check; defense-in-depth belongs at authoring, where a rejection is actionable.

Message shape: `<diagnosis>. Try grep.pattern: <corrected pattern>`. Examples: `test:graduate-crowned` → `test:.*crowned` (npm script); `quant-desk` → `(?i)\bquant\b` (kebab-case; case-insensitive since `Quant-desk` ≠ `quant-desk`); `scaler.test.ts` → `scaler\.test\.` (test filename); `handleRedemption` → same string plus advice to pin in the spec body. Author sees the fix — a rejection that hides it just moves the guessing.

#### Closed holes — grep-check-guess-guard-closes-alternation-and-pin-gaps (2026-08-03)

The original guard shipped with two holes measured on 2026-08-02 that stranded two correctly-built specs (`a-subscription-mutation-must-verify-it-happened-not-trust-http-200` + `no-send-path-can-emit-an-unsubstituted-placeholder`) — each spec burned all three of its allowed redrives against an assertion that could never match. Both holes are closed:

1. **Alternation of guessed names.** The metachar bail treated `|` as "the author intends a real pattern" — but an alternation of TWO OR MORE bare-literal branches is not a pattern, it is several guesses joined by a pipe, and it is strictly WORSE than a single guess because it reads as more thorough while staying just as unmatchable. Live incident: `verifyMutation|verifyContractState|assertLineState` sailed through while `verifyContractState` alone was flagged. Fix: `detectBuilderChosenNameInGrep` splits on top-level `|`, requires every branch to be a bare literal (no branch carries its own metachars), and rejects only when EVERY branch flags — a real alternation with one genuine spec-pinned branch (or one real-regex branch) stays legal. Suggested pattern is a case-insensitive alternation of the distinctive tokens.

2. **The pin exempted; it did not bind.** The `specText.toLowerCase().includes(p)` escape valve let a check whose builder-chosen literal appeared in the spec body pass — but nothing carried that literal to the builder as a REQUIREMENT, so the builder still picked whatever name read best and the check still could not match. Two of three bad checks landed this way despite the guard flagging both in isolation. Fix: `collectSpecPinnedGrepLiterals(grepPatterns, specText)` (co-exported) extracts every literal the pin exempted (WITHOUT specText would flag; WITH specText returns null — the pin is the sole reason it's allowed), splitting alternations the same way. `scripts/builder-worker.ts` calls it right before the build-session prompt is composed and injects a `⭐ REQUIRED API` line naming each pinned identifier + the "change the spec, not the code" invariant, so a pinned name is BINDING on the builder rather than a wish dressed as a contract.

Both closed rules are pinned by the guard's own test file (`src/lib/spec-phase-checks-table.test.ts`, wired to `test:spec-phase-checks-table` — the file was previously grandfathered on the tests-registered allowlist with no runner) — the alternation cases exercise the four combinations named in the spec (triple-guess rejects, single-guess still rejects, mixed with spec-pinned stays allowed, real-regex stays allowed) and the collector cases exercise pinned-yes / rejected-not-pinned / real-regex / bare-word / mixed-alternation / dedup+sort.

#### Existing-defect sweep: scripts/_check-spec-grep-guess-sweep.ts

Closing the holes stops new bad checks, but every check authored BEFORE the fix was written under the old rules and could still be a dormant trap. `scripts/_check-spec-grep-guess-sweep.ts` (`npm run check:spec-grep-guess-sweep`) is a READ-ONLY sweep that walks every non-folded spec via [[specs-table]] `listSpecs({ scope: 'active' })`, iterates each phase's grep checks via `listPhaseChecks`, and re-runs the repaired `detectBuilderChosenNameInGrep` over each pattern with the OWNING spec's text (same shape the author-time chokepoint uses — spec why/what + phase title/why/what/body). Offenders print as `spec / phase / check` with the corrected suggestion; the process exits non-zero when any are found. `--json` for a machine-readable report, `--workspace <uuid>` to override the default Superfoods workspace. NEVER auto-rewrites a check — a wrong automatic loosening can make an assertion pass without the behaviour existing, which is exactly the failure mode this whole area exists to prevent. Not chained into `predeploy` because it needs live DB creds; it is an operator-triggered inventory pass.

The two known-good repairs already applied by hand on 2026-08-02 (subscription-mutation's `verifyContractEndState` + `test:.*mutation-verify`; placeholder's `resolvePlaceholderSafeMessage|stripUnsubstitutedPlaceholders`) sit correctly outside the offender set — the subscription-mutation names are pinned in the spec body and the placeholder pattern is an alternation both of whose branches the placeholder spec names.

### Grep is smart-case: shouldGrepCaseInsensitively

[[../specs/spec-phase-check-grep-is-smart-case]] Phase 1 — this module exports the ONE
`shouldGrepCaseInsensitively(pattern: string): boolean` predicate that decides whether a spec's
grep check matches case-insensitively. Rule (ripgrep's `--smart-case` semantic): the predicate
returns `true` when the pattern contains NO uppercase ASCII letter — the author is writing a
prose phrase and cannot know the source's capitalization — and `false` otherwise (any uppercase
means the author is naming an identifier like `VERCEL_LOG_DRAIN`, `ErrorSource`, or
`onRequestError` where casing is load-bearing).

BOTH grep lanes route through this single predicate so they cannot drift: [[spec-check-runner]]
`buildGrepArgv` prepends `-i` when it returns true (deliberately NOT ripgrep's own `-S` flag —
the predicate must be the sole answer so the sibling lane can't diverge), and [[specs-table]]
`defaultRunGitGrepOnBranch` inserts `-i` the same way (`git grep` has no `--smart-case` flag at
all, which is precisely why the userland predicate exists). Both lanes append a `[smart-case: -i]`
marker to their evidence string when the case-insensitive path fired, so a reader of a failed
check can tell which matching mode ran.

Ground-truth incident (2026-08-14 to 2026-08-17): the spec
`replace-log-drain-with-in-process-onrequesterror` built all three of its phases correctly onto
its branch and then parked for three days on ONE check whose pattern read
`cannot filter by log level` while the page it checked wrote that phrase with the first word
capitalized for emphasis. Three redrives re-failed the identical grep, the redrive cap fired,
Ada correctly declined a fourth as a loop, and the spec died on the board with correct code
sitting on its branch. This is the rail that closes that defect class. Escape hatch: put an
uppercase letter in the pattern when casing IS load-bearing.

Pinned by `src/lib/spec-check-runner.smart-case.test.ts` (`npm run test:grep-smart-case`) — the
predicate returns true for a lowercase phrase and false for `VERCEL_LOG_DRAIN` / `ErrorSource` /
`onRequestError`; `buildGrepArgv` includes `-i` for the former and omits it for the latter; and
the exact historical case (`cannot filter by log level` matching `CANNOT filter by log level`
under the `-i` flag; NOT matching without it) is pinned.

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
