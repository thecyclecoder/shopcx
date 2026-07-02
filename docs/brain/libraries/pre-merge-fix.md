# libraries/pre-merge-fix

Phase 2 of [[../specs/promote-on-green-merge-gate]] — **Hold-or-fix on red + loop-guard**. The auto-merge gate's Phase-1 tests-gate ([[github-pr-resolve]] `autoMergeReadyPrs`) already HOLDS a built PR `in_testing` when its pre-merge `spec-test green` OR `security green` signal is missing/red. This module is the *"spawns a fix"* half — on a RED pre-merge spec-test on a `claude/*` build branch, author a deterministic fix-spec via the same fix-spec mechanism the inline owner Request-a-fix surface uses, AND apply a bounded loop-guard so a stuck branch ESCALATES instead of churning tokens.

**File:** `src/lib/pre-merge-fix.ts` · called inline from `scripts/builder-worker.ts` `runSpecTestJob` immediately after the shipped-only [[regression-agent]] branch (which misses pre-merge red because [[spec-test-runs]] `getHumanTestQueue` is shipped-only).

## North star — bounded fix-spawn, never silent retry

Hitting the rail = **escalate, not execute** ([[../operational-rules]] § North star). After `PRE_MERGE_FIX_LOOP_GUARD_MAX` (2) prior fix-specs already exist for an origin, the next RED pre-merge spawn records a [[../tables/director_activity|director_activity]] `escalated` row and does **NOT** author another fix. The auto-merge gate's tests-gate still refuses to promote the red PR (Phase 1 fails CLOSED on a missing green signal), so a no-spawn never promotes a red build — the build stays held `in_testing` until the owner unblocks it.

## Exports

- `PRE_MERGE_FIX_LOOP_GUARD_MAX = 2` (env-overridable via `PRE_MERGE_FIX_LOOP_GUARD_MAX`) — mirrors [[regression-agent]] `REGRESSION_LOOP_GUARD_MAX` (2), [[deploy-guardian]] `DEPLOY_GUARDIAN_LOOP_GUARD_MAX` (2), [[github-pr-resolve]] `MAX_PR_RESOLVE_ATTEMPTS` (3). After this many fix attempts, the next RED escalates instead of spawning.
- `PRE_MERGE_FIX_MAX_DEPTH = 1` (env-overridable via `PRE_MERGE_FIX_MAX_DEPTH`) — depth cap on the `regression_of_slug` CHAIN — the fix-of-fix escalation rail. The breadth guard counts DIRECT siblings under ONE origin, so when `fix-X`'s own pre-merge spec-test goes red, `preMergeFixChainDepth('fix-X')` counts ONE hop (depth 1). At depth ≥ `PRE_MERGE_FIX_MAX_DEPTH`, escalate instead of authoring `fix-fix-...` — bounds the chain and escalates unbounded recursion to the owner. ([[../specs/archive.d/pre-merge-fix-depth-guard-and-check-scoping]] Phase 1)
- `preMergeFixChainDepth(admin, workspaceId, originSlug)` → walk the `regression_of_slug` chain from `originSlug` upward and return the number of hops until null (true origin) OR self-reference OR repeat (cyclic data) OR hop-cap (10). For the chain `X ← fix-X ← fix-fix-X`: depth('X')=0, depth('fix-X')=1, depth('fix-fix-X')=2. Read-only + best-effort — a DB read error terminates the walk at current depth (never returns 0 on error, so a transient blip doesn't accidentally allow unbounded chains).
- `buildPreMergeFixSlug(originSlug, failingKeys)` → `fix-{origin}-{6hex of sorted-unique check-key set}`. Same origin + same failing-check set → same slug → UPSERT (author) + dedup (enqueue) converge. A NEW failing check on the same origin → different hash → a new fix-spec (genuinely new break gets its own attempt + counts toward the loop-guard). Mirrors the inline Request-a-fix route's hashing so a click + an autonomous spawn on the SAME break converge.
- `countPreMergeFixAttempts(admin, originSlug)` → distinct fix-specs already authored for this origin (`specs.regression_of_slug = origin`). One spec = one attempt regardless of whether the build merged, failed, or is in-flight. Best-effort + read-only — a DB read error returns 0 so a one-off blip never blocks the first spawn.
- `spawnPreMergeFix(admin, { workspaceId, originSlug, originTitle, branch, failing })` → the Phase-2 chokepoint. **DEPTH guard FIRST** (escalates when depth ≥ `PRE_MERGE_FIX_MAX_DEPTH`; records `director_activity` with `metadata.signature='pre-merge-fix-depth-guard'`), then **loop-guard** (escalates on breadth hit; `metadata.signature='pre-merge-fix-loop-guard'`); else authors a deterministic fix-spec carrying `regression_of_slug = origin`, marks the card `in_review`, and enqueues ONE `kind='build'` agent_job (dedup against an existing build row — convergent re-spawn). **Best-effort, never throws.** Returns a typed `SpawnPreMergeFixResult` with an optional `depth` field (populated only on depth-guard escalations).

## How the loop closes

A fix-spec authored here carries `specs.regression_of_slug = origin`. After its build merges to main, [[agent-jobs]] `retestOriginIfFixMerged` reads that column and enqueues a fresh spec-test on the **origin** — the same `fix-ship-retests-origin` mechanism the spec describes as "the same mechanism that re-tests an origin after a fix lands". When the origin's pre-merge spec-test runs clean against its refreshed preview, [[spec-test-runs]] `isSpecTestGreenForBranch` flips true → the auto-merge gate's Phase-1 tests-gate stops holding the origin's PR `in_testing` → the origin promotes on its next pass. The card-board derivation in [[brain-roadmap]] `applyInTestingOverlay` reads the SAME signals so the board and the gate stay in sync.

## Trigger — inline from `runSpecTestJob`

`scripts/builder-worker.ts` `runSpecTestJob` already classifies each run as pre-merge (`branch && previewOrigin` → `isPreMerge`). Phase 2 added a new branch right after the shipped-only regression branch: on `agent_verdict === "issues"` AND `isPreMerge`, it gathers the failing checks from the just-inserted [[spec_test_runs]] row's `checks[]` (each `c.verdict === 'fail'` → `{ text, evidence, check_key }`), pulls the origin title via [[specs-table]] `getSpec`, and calls `spawnPreMergeFix`. Post-merge runs on shipped specs hit the existing [[regression-agent]] path (this branch is inert there because `isPreMerge` is false).

## Verification ([[../specs/promote-on-green-merge-gate]] Phase 2 + [[../specs/archive.d/pre-merge-fix-depth-guard-and-check-scoping]] Phase 1)

- A build whose pre-merge spec-test fails → NO merge (Phase 1 tests-gate holds the PR `in_testing`) + a fix-spec build enqueued for the build via `spawnPreMergeFix`; the [[brain-roadmap]] card stays `in_testing` (`applyInTestingOverlay` reads the same signals).
- Drive `PRE_MERGE_FIX_LOOP_GUARD_MAX + 1` red→fix cycles on the same origin → the loop-guard escalation kicks in: no new fix-spec is authored, a `director_activity` `escalated` row is written instead (with `metadata.signature='pre-merge-fix-loop-guard'`), the origin's PR continues to be held `in_testing`. No infinite re-spawn.
- Drive a fix-of-fix chain (`X ← fix-X ← fix-fix-X`) to depth ≥ `PRE_MERGE_FIX_MAX_DEPTH` (default 1) → the depth-guard escalation kicks in: `preMergeFixChainDepth` walks the chain and returns the correct depth; when depth ≥ max, `spawnPreMergeFix` records a `director_activity` `escalated` row (with `metadata.signature='pre-merge-fix-depth-guard'` + depth metadata), no new spec is authored, no build is queued. The origin's PR stays held `in_testing` by the independent tests-gate; escalating-without-spawning never promotes a red build.
- Grep `src/lib/pre-merge-fix.ts` → `PRE_MERGE_FIX_LOOP_GUARD_MAX` is the breadth cap; `PRE_MERGE_FIX_MAX_DEPTH` is the depth cap; both are bounded retry rails with no unbounded path past them.

## Known fixes

- **Owner field normalization** ([[../specs/fix-pre-merge-red-owner-shape]]) — the `spawnPreMergeFix` path sets `owner: "platform"` (bare slug); the [[author-spec]] `authorSpecRowStructured` entry point normalizes any wikilink-wrapped owner before writing to the DB. This prevents regression where pre-merge-red authoring would write mangled `"[[../functions/platform]]"` values to `specs.owner`.

## Related

- [[../specs/promote-on-green-merge-gate]] (the M4 goal)
- [[github-pr-resolve]] — Phase 1 tests-gate ([[../specs/promote-on-green-merge-gate]] Phase 1), `MAX_PR_RESOLVE_ATTEMPTS`
- [[regression-agent]] — the post-ship analogue (shipped-spec regressions on the standing lane), `REGRESSION_LOOP_GUARD_MAX`
- [[deploy-guardian]] — Reva's post-prod analogue, `DEPLOY_GUARDIAN_LOOP_GUARD_MAX`
- [[spec-test-runs]] — `isSpecTestGreenForBranch` (the green signal the Phase-1 gate reads), `getHumanTestQueue` (post-ship regressions)
- [[security-agent]] — `isSecurityGreenForBranch` (the other Phase-1 green signal)
- [[agent-jobs]] — `retestOriginIfFixMerged` (the loop-close — re-tests the origin after the fix's build merges)
- [[brain-roadmap]] — `applyInTestingOverlay` (board card derives `in_testing` from the SAME signals the gate reads)
- [[specs-table]] — `regression_of_slug` column (the loop-guard ledger + the post-merge re-test link)
- [[author-spec]] — `authorSpecRowStructured` (DB-only fix-spec authoring)
- [[../tables/director_activity]] — `escalated` / `authored_fix` rows the recap reads back
