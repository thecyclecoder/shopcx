# Incident: the security-review spec avalanche (2026-07-03)

A single pre-merge **security finding** recursively authored a chain of near-duplicate fix specs — superseded, conflicting PRs and a runaway escalation storm. The canonical **Goodhart / north-star** failure ([[../operational-rules]] § North star): a proxy-optimizing tool with no objective-owner supervising it against a degenerate state.

## Timeline / blast radius

- **#1069** `destructive-migration-safety-rails` — the real, human-authored spec (a local session). Shipped + folded.
- Its unmerged branch drew a **fused pre-merge review** (Vera spec-test + Vault security, same session). Vault found a `real-vuln` (blast-radius computation executes proposed SQL against prod under BEGIN/ROLLBACK) → the old code **authored a standalone fix spec** + queued its build:
  - `prevent-prod-dry-run-transaction-escape` (PR #1071), `disable-production-migration-dry-run-execution` (#1070), `secure-destructive-migration-preapproval-boundary` (#1073, the ONE that merged cleanly).
- Each fix spec built on **its own branch** → drew **its own** fused review → Vault found (the same class of) vuln → **authored another fix spec**: `scope-destructive-route-override-to-out-of-leash-jobs` (#1074/#1075) from #1071's branch. A **fix-of-fix chain**.
- The `-fix-blocker-<hash>` path (a build blocker → a standalone child spec) added a second spawner: `prevent-…-fix-blocker-7ba2f8`, `disable-…-fix-blocker-f634e4`.
- Meanwhile **#1069 merged first**, so every fix spec's hardening was already on main → their PRs went `CONFLICTING/DIRTY` → superseded. `pr-resolve` retried each endlessly, escalating **per-job** → **21 parked jobs / 21 CEO cards**.

## Root cause — three failures, one shape

1. **The fused review ate its own output.** Every in-flight branch — INCLUDING the branch of a security-authored fix spec — gets a fused Vault review. On a `real-vuln` the old path authored a NEW standalone spec, which itself got reviewed → another spec. No depth guard, no "don't review a fix's own branch," no dedup against an open fix for the same finding.
2. **The fixes were near-clones.** Every finding lived in the same code #1069 introduced (migration-safety / blast-radius / approval-routing), so each fix re-touched the same ~16 files and re-applied the same hardening. Vault kept flagging the same pattern on each successive branch. "Nothing new in them besides the original spec."
3. **No supervisor circuit-breaker.** The security tool optimized a bounded proxy — *"author a fix for every finding"* — and, with nothing owning *"is the code actually secure now?"*, drove it to a degenerate state (endless near-duplicate fixes). Classic proxy-optimizer with no objective-owner ([[../operational-rules]] § North star).

## The fixes (all shipped as hotfixes — NOT specs, to avoid feeding the recursion)

- **#1079 — security findings → fixes-as-phases.** `applyFusedSecurityAsBranchVerdict` (`scripts/builder-worker.ts`) routes a pre-merge `real-vuln` through `spawnPreMergeFix` ([[../libraries/pre-merge-fix]]) — a `kind='fix'` phase on the ORIGIN + resume its build — instead of a standalone spec. Structurally kills the recursion (the fix lives on the origin's branch; no second spec to re-review). Stable `sec:<check>[:<location>]` keys give the loop-guard + per-key dedup (**Vault finding-level dedup** — an open fix phase for the same finding converges, never re-authors). The fix ships on the origin's own branch, so its re-test is a **fused Vera+Vault** run — a security fix is re-verified by Vault, not just Vera.
- **fix-blocker → fixes-as-phases.** `routeAuthorBlocker` ([[../libraries/needs-attention-route]]) now appends a blocker Fix phase to the origin via `spawnPreMergeFix` instead of a standalone `{slug}-fix-blocker-{hash}` child — closing the second spawner (same loop-guard bound).
- **Runaway-authoring circuit-breaker.** At the sole author chokepoint (`author-spec.ts` `authorSpecRowStructured`): if `RUNAWAY_FIX_THRESHOLD` (5) derivative-fix specs are authored inside `RUNAWAY_FIX_WINDOW_MIN` (30 min), the next one **halts + escalates to the CEO** instead of spawning. The catch-all backstop for ANY future derivative-spawn path; fails OPEN (never blocks a legit author) and never trips on planner-milestone / human authoring.
- **pr-resolve escalation dedupe per-PR** (#1079, [[../libraries/platform-director]]) — N parked pr-resolve jobs for one PR collapse to ONE inbox card (`needsattn:{spec_slug}`).
- **#1082 — `setSpecStatus` parks the `deferred` boolean** so retiring a runaway spec actually removes it from the board ([[../libraries/specs-table]]).

## Cleanup performed

Closed PRs #1070/#1071/#1074/#1075/#1078; deleted their orphan branches; folded (archived) all 5 chain orphan specs + the 2 fix-blocker children; cancelled every live/parked job; cleared the 21 CEO cards.

## Lessons

- **Never let a fixing tool review its own fixes without a depth/dedup guard** — a review that authors work, then reviews that work, is a loop by construction.
- **A fix is a phase on the origin, not a new spec** ([[../libraries/pre-merge-fix]] fixes-as-phases, 2026-07-02) — retro-applied here to the security + blocker paths. Any NEW auto-fixing path must adopt it.
- **Every autonomous proxy-optimizer needs a circuit-breaker its supervisor owns** — the north star is not just a principle, it needs a mechanical rail (the runaway breaker).
- **Fix pipeline bugs with hotfixes, not specs** — a spec to fix the recursion would itself run through the recursing pipeline.
