# libraries/predeploy-guard-extract

Names **which guard** in the `predeploy:static` chain rejected a build.

**File:** `src/lib/predeploy-guard-extract.ts` · **Test:** `src/lib/predeploy-guard-extract.test.ts` (`npm run test:predeploy-guard-extract`) · **Caller:** [[../../../scripts/builder-worker]] build lane · **Context:** [[../operational-rules]] § Predeploy static guards

## Why it exists

The build lane runs the ~21 hermetic `scripts/_check-*.ts` guards as a blocking pre-commit step. When the chain exits non-zero the lane must tell Bo — and, on repair-cap exhaustion, the CEO — **which rail broke**, because each guard prints its own remediation next to its failure line. A park that says only "something failed" is a park nobody can act on.

The predecessor was a single regex, `/❌\s*(check-[^\s—]+)/`, run against the chain's combined stdout+stderr. It silently failed the common case: **the guards do not share one output format.** Some print `❌ check-foo — remediation`, some print `❌ <prose>` with no slug, some surface only through npm's lifecycle frame, some just exit non-zero from a stack trace. On **2026-08-10, 4 of the 6 builds** that parked on this gate reported the literal string `"unknown check"` — the CEO got a park with no remediation, and the retry had nothing new to act on. A wrong-but-plausible regex reads as working, which is why the replacement is unit-tested against each real shape.

## Exports

- `extractFailedPredeployGuards(out: string): string[]` — every distinct guard named anywhere in the output, deduped, in first-seen order.
- `extractPredeployViolationPaths(out: string): string[]` — the repo-relative source paths (starting `src/`, `scripts/`, `supabase/`, `docs/`) a guard named as violating, deduped in first-seen order. Covers the two shapes our guards actually emit — the `  • {file}:{line}  →  {snippet}` line and the `  [VIOLATION] {file}:{line}  {snippet}` line — and skips the `> shopcx-init@… check:foo` / `> tsx scripts/_check-*.ts` npm lifecycle frame so the chain header can never be mistaken for a violation (same defensive property `extractFailedPredeployGuards`' `lastEcho` rule carries).
- `classifyPredeployViolationScope({ out, changedPaths }): { owned, inherited, allInherited, paths }` — splits the extracted paths into ones the branch OWNS (path is in its diff) and ones it INHERITED from main (path is not). Both sides normalized (leading `./` stripped, backslashes to `/`) before comparison. `allInherited` is TRUE **only** when at least one path was extracted AND none of them appears in `changedPaths` — an EMPTY extraction yields `allInherited: false` so the caller falls back to today's repair-it behavior rather than silently skip a real violation. **This fail-closed default is the load-bearing rule of the owned-vs-inherited split.**

## Owned vs inherited — why the split exists

The build lane runs the full predeploy chain repo-wide as a blocking pre-commit gate and, on failure, **resumes the build session to REPAIR the violation** — with no check on whether the offending file is one this build touched. A violation that already existed on main therefore gets repaired independently, in-session, by EVERY concurrent build. Each authors its own wording of the same fix in files its spec has no business editing, and whichever branch merges first turns all the others into reconcile conflicts the box refuses to auto-resolve (source files are excluded from the additive-only tier by design).

Ground truth: **2026-08-31** — the `cold-scaler-arming-decides-on-evidence-not-absence` and `creative-scout-job-stamps-spec-slug` builds BOTH sat parked at `needs_attention` / `reconcile_conflict` for **6 days** on the SAME three files — `scripts/_kcups-blockers.ts`, `_kcups-competitors.ts`, `_kcups-readiness.ts` — because each had independently made the same repair to clear the competitors SDK compliance guard, while a separate PR landed that identical fix on main. Neither spec was about kcups. The classifier draws the exact line the repair loop was missing.

**Fail-closed default (the load-bearing rule).** An unparseable guard output produces `paths=[]` → `allInherited=false` → the caller repairs as today. Silently skipping a real violation would be strictly worse than a redundant repair, so the classifier never claims "nothing this branch owns" from an empty extraction.

**Mixed case.** When the extraction contains BOTH owned and inherited paths (e.g. the branch touched one violating file plus main introduced two more), the classifier returns `allInherited=false` and the repair proceeds — the branch genuinely owns part of it. The dedup-fix rail can only pick up FULLY inherited failures.

## Caller

The worker's `predeploy:static` repair loop (`scripts/builder-worker.ts`, guarded by `PREDEPLOY_REPAIR_MAX`) computes the branch's changed paths ONCE via `git diff --name-only origin/main...HEAD` and calls `classifyPredeployViolationScope` on every non-zero staticCheck. When `allInherited === true` the loop **breaks** (treats the gate as passed for this commit), records a `predeploy_inherited_violation_skipped` `director_activity` row (`directorFunction: 'platform'`, `metadata: { guards, inherited_paths, … }`), and enqueues ONE deduped fix spec via `authorSpecRowStructured` keyed on `predeploy-violation-{guard}` — so the second, third and Nth build that hits the same inherited violation re-author the SAME row idempotently ([[author-spec]] `reopenIfReauthoredAndChanged`) instead of opening N specs. See [[builder-worker]] § Predeploy static gate.

Shape **(0)** is authoritative when present and **short-circuits**; otherwise shapes (a)/(b)/(c) are tried and their union returned:

| # | Shape | Example |
|---|---|---|
| **0** | **npm's PER-SCRIPT echo — the last one is the failure** | `> shopcx-init@0.1.0 check:node-registry-drift` |
| a | the guard's own failure line | `❌ check-rls-on-new-tables — table "public.foo" has no RLS policy` |
| b | npm's lifecycle frame for the failing script in the `&&` chain | ``npm error Lifecycle script `check:node-registry-drift` failed`` |
| c | a `scripts/_check-*.ts` path in a stack trace / exec echo | `at main (/repo/scripts/_check-tests-registered.ts:88:11)` |

**Why (0) has to win** (the CEO-inbox signal-to-noise hot fix, 2026-08-11). `predeploy:static` chains its guards with `&&`, so npm's FIRST output line is the whole chain — `> npm run check:a && npm run check:b && …` — which shape (b)'s `npm run` pattern happily matched, returning **all ~21 guards** as failing. That string lands in `agent_jobs.error`, which is exactly what the needs-attention classifier buckets on to route a park, and it would point a repair pass at 21 files instead of one. Because npm echoes each script as it starts and an `&&`-chain **stops at the first failure**, the LAST per-script echo *is* the guard that broke — so (0) returns that single guard and skips the union entirely. Verified against real `npm run predeploy:static` output.

Names are normalized onto the guards' own `check-foo` form (npm's `check:foo` maps onto it), so one guard surfacing through two shapes counts once. Trailing punctuation is stripped.

**Returns EMPTY when genuinely unattributable** — the caller renders that as `"unattributable guard (see log_tail)"`. It never invents a name: a wrong guard name would point Bo's repair pass at the wrong file, which is worse than admitting we don't know.

## ⚠️ Why this is a `src/lib/` module and not a function in the worker

**Importing `scripts/builder-worker.ts` BOOTS THE WORKER** — it has a module-level main loop and reaper. On 2026-08-11 a unit test that imported the worker to reach this helper started a real worker, whose reaper logged `PRIMARY REPO_DIR … is off-main or dirty — HEALING to main` and **discarded the developer's uncommitted work** in that worktree. The test also hung for 156s instead of finishing in 136ms.

**Rule:** any pure helper the worker needs that something else (a test, a route, another lib) must also import belongs in `src/lib/`, never in `builder-worker.ts`. Pure — no I/O, no imports — so it is safe to unit-test and safe to call from anywhere.
