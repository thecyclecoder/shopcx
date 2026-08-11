# libraries/predeploy-guard-extract

Names **which guard** in the `predeploy:static` chain rejected a build.

**File:** `src/lib/predeploy-guard-extract.ts` · **Test:** `src/lib/predeploy-guard-extract.test.ts` (`npm run test:predeploy-guard-extract`) · **Caller:** [[../../../scripts/builder-worker]] build lane · **Context:** [[../operational-rules]] § Predeploy static guards

## Why it exists

The build lane runs the ~21 hermetic `scripts/_check-*.ts` guards as a blocking pre-commit step. When the chain exits non-zero the lane must tell Bo — and, on repair-cap exhaustion, the CEO — **which rail broke**, because each guard prints its own remediation next to its failure line. A park that says only "something failed" is a park nobody can act on.

The predecessor was a single regex, `/❌\s*(check-[^\s—]+)/`, run against the chain's combined stdout+stderr. It silently failed the common case: **the guards do not share one output format.** Some print `❌ check-foo — remediation`, some print `❌ <prose>` with no slug, some surface only through npm's lifecycle frame, some just exit non-zero from a stack trace. On **2026-08-10, 4 of the 6 builds** that parked on this gate reported the literal string `"unknown check"` — the CEO got a park with no remediation, and the retry had nothing new to act on. A wrong-but-plausible regex reads as working, which is why the replacement is unit-tested against each real shape.

## Exports

- `extractFailedPredeployGuards(out: string): string[]` — every distinct guard named anywhere in the output, deduped, in first-seen order.

Tries three shapes and returns the union:

| # | Shape | Example |
|---|---|---|
| a | the guard's own failure line | `❌ check-rls-on-new-tables — table "public.foo" has no RLS policy` |
| b | npm's lifecycle frame for the failing script in the `&&` chain | ``npm error Lifecycle script `check:node-registry-drift` failed`` |
| c | a `scripts/_check-*.ts` path in a stack trace / exec echo | `at main (/repo/scripts/_check-tests-registered.ts:88:11)` |

Names are normalized onto the guards' own `check-foo` form (npm's `check:foo` maps onto it), so one guard surfacing through two shapes counts once. Trailing punctuation is stripped.

**Returns EMPTY when genuinely unattributable** — the caller renders that as `"unattributable guard (see log_tail)"`. It never invents a name: a wrong guard name would point Bo's repair pass at the wrong file, which is worse than admitting we don't know.

## ⚠️ Why this is a `src/lib/` module and not a function in the worker

**Importing `scripts/builder-worker.ts` BOOTS THE WORKER** — it has a module-level main loop and reaper. On 2026-08-11 a unit test that imported the worker to reach this helper started a real worker, whose reaper logged `PRIMARY REPO_DIR … is off-main or dirty — HEALING to main` and **discarded the developer's uncommitted work** in that worktree. The test also hung for 156s instead of finishing in 136ms.

**Rule:** any pure helper the worker needs that something else (a test, a route, another lib) must also import belongs in `src/lib/`, never in `builder-worker.ts`. Pure — no I/O, no imports — so it is safe to unit-test and safe to call from anywhere.
