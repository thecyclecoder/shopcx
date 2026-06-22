# Dirty-PR-resolver: detect already-merged duplicates (don't loop) + prevent the duplicate PR ⏳

**Owner:** [[../functions/platform]] · **Parent:** hardens [[dirty-pr-resolver-agent]] + the build PR-create path. · **Found in use 2026-06-22:** `storefront-lever-importance-memory` was built **twice** during the account-switch recovery — #252 merged the work, leaving #249 as a duplicate of the same spec. #249 went permanently **CONFLICTING** (its content already on main), so the dirty-PR-resolver kept trying to rebase it and **spawned 9 pr-resolve jobs** that could never succeed — burning Max tokens in a loop. Closing #249 by hand stopped it.

A PR whose work already merged via a *sibling* PR is **unresolvable by definition** — rebasing/merging main into it just re-conflicts, because the diff is already there. The resolver treated it like any dirty PR and looped.

## Fix (two parts)
- **Resolver detects the already-merged duplicate (stops the loop).** Before attempting a resolve, the dirty-PR-resolver checks: does this PR's spec already have a **merged** build PR (or is its content wholly on `main`)? If so → **close the PR (+ delete branch) instead of resolving**, with a clear comment, and do NOT enqueue another pr-resolve. A conflicting PR is only worth resolving if its work is *not* already merged.
- **Prevent the duplicate PR at the source.** A second build for a spec that **already has a merged or open build PR** shouldn't open a competing PR. At build-claim / PR-create, dedupe on `spec_slug`: if a merged build PR exists → the new build no-ops ("already shipped"); if an open one exists → reuse/supersede it, don't open a parallel branch. (The account-switch requeue is what created the dup — requeue must skip specs whose build already merged.)
- **Cap the resolve attempts (backstop).** A single PR should not spawn unbounded pr-resolve jobs — cap retries (e.g. ≤3) and, on exhaustion, surface it to the owner rather than looping forever. Prevents any *future* unresolvable case from burning tokens indefinitely.

## Verification
- A CONFLICTING `claude/*` PR whose spec already has a merged build PR → the resolver **closes it** (branch deleted, comment left), enqueues **no** further pr-resolve job; a genuinely-conflicting PR whose work is NOT merged still gets resolved normally.
- Re-queue a build for a spec that already merged (simulate the account-switch recovery) → **no second PR** is opened (the build no-ops as already-shipped); `requeue-failed-builds` skips already-merged specs.
- A PR that fails to resolve N times (N≤3) → stops retrying and surfaces to the owner (a repair/needs-attention signal), never an open-ended loop.
- Negative: a normal first-time dirty PR resolves on the first pass as today; a spec with no prior merged PR builds + PRs normally.

## Phase 1 — already-merged detection + close + PR dedup + retry cap ⏳
Resolver checks sibling-merged/content-on-main before resolving → close+stop; build/PR-create + `requeue-failed-builds` dedupe on a merged build PR per spec; cap pr-resolve retries with owner surfacing on exhaustion. Brain: [[dirty-pr-resolver-agent]] · [[../libraries/roadmap-actions]] · [[../libraries/agent-jobs]] · [[auto-ship-pipeline]].
