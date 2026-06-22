# Auto-Ship Pipeline — auto-merge ready PRs + auto-fold verified specs ⏳

**Owner:** [[../functions/platform]] · **Parent:** extends [[dirty-pr-resolver-agent]] (the PR-webhook half) + the fold mechanism + [[spec-test-on-ship]]. Removes the two manual button-clicks the owner makes without additional review.

Two bottlenecks are pure rubber-stamps — the owner clicks "merge" on green PRs and "Mark verified & archive" on all-green specs without reviewing further. Automate the clicks, keep the judgment: each gate optimizes a **bounded proxy** (merge-when-green / fold-when-all-pass), the owner still owns the objective + can pause either gate, and every action is surfaced. This is the supervisable-autonomy pattern ([[../operational-rules]] § North star), not a silent auto-merger.

## Gate A — auto-merge ready PRs
- **Trigger:** the GitHub PR webhook (same feed [[dirty-pr-resolver-agent]] already consumes — this is its mirror: that one handles CONFLICTING, this one handles READY).
- **Condition:** a `claude/*` **build** PR (box-authored) that is **mergeable (no conflicts) AND all checks green** → **squash-merge + delete branch** (mirrors the owner's manual action + the watcher pattern used all session).
- **Guardrails:**
  - `claude/*` build/fix PRs only — never a human PR, never a non-build branch.
  - **Serialize:** merge ONE at a time (a queue), never fan out N merges → N simultaneous Vercel deploys.
  - **Skip while an Inngest sync is active** (a deploy kills running functions — the standing rule); defer to the next safe window.
  - Conflicting PRs are left for [[dirty-pr-resolver-agent]] (not force-merged).
  - The post-merge [[spec-test-on-ship]] is the safety net: a bad-but-green build surfaces as a regression → the existing fix/repair flow. Auto-merge doesn't need to *judge* the code (the owner didn't either) — it needs to ship what's ready and let the spec-test catch what's wrong.

## Gate B — auto-fold fully-verified specs
- **Trigger:** periodic + reactive (on a spec-test completing or a human-check resolution changing).
- **Condition:** a spec that is **shipped + agent-verdict `approved` + 0 human checks waiting + 0 human checks failed + 0 regressions** → `enqueue_fold` (the batch "Mark verified & archive"). Exactly the all-green state the owner archives on.
- **Guardrails:** ALL-green only — never fold a spec with a single open / failed / waiting check (it doesn't skip human testing, it just stops making the owner click once the human is done). Coalesce into the existing batch fold-build.

## North-star compliance
- Both gates **register as monitored loops** in the Control Tower (the rule: every agent watches itself) and **surface every action** (merged PR #, folded spec) to the Control Tower feed / a log.
- An **owner kill-switch** per gate (a workspace flag) — pause auto-merge or auto-fold instantly.
- Neither gate ever overrides a guardrail (a conflict, a red check, a failing test) — hitting a rail = leave it for the human/the resolver, never force through.

## Verification

### Phase 1 — auto-merge gate (Gate A) ✅
- In GitHub repo settings, subscribe the `https://shopcx.ai/api/webhooks/github` hook to **Check suites + Check runs + Statuses** (on top of Pushes + Pull requests), and apply migration `20260622180000_workspaces_auto_merge.sql`.
- Open a clean `claude/*` build PR and let its CI go green → expect within the next webhook (its `check_suite`/`check_run` `completed` delivery): the PR is **squash-merged** + the branch deleted, and the delivery response carries `autoMerge.merged:1, autoMerge.mergedPr:<N>`. Confirm on GitHub the PR shows "merged" and the branch is gone.
- Open a `claude/*` PR with a **failing/pending** check (`mergeable_state` `unstable`/`blocked`) → expect it is NOT merged (`autoMerge.ready` excludes it); a **CONFLICTING** one (`dirty`) → NOT merged (it still enqueues a `pr-resolve` job); a **human** (non-`claude/*`) PR → never touched.
- Have **two** ready `claude/*` PRs at once → expect ONE merges this pass (`autoMerge.merged:1`); the resulting push-to-main webhook merges the second (serial, never two simultaneous Vercel deploys).
- Insert a `sync_jobs` row `status='running'` (created < 2 h ago) → fire a check webhook → expect `autoMerge.syncActive:true, merged:0` (deferred); remove it → the next webhook merges.
- Set `workspaces.auto_merge_enabled=false` on the build-console workspace → fire a check webhook on a ready PR → expect `autoMerge.enabled:false, merged:0` (not merged); set it back to `true` → it merges.
- On `/dashboard/developer/control-tower`, expect an **`auto-merge-gate`** reactive tile (Platform); idle/clean passes = green, a beat's `produced` shows `{checked, ready, merged, mergedPr}`. Each merge is in the Vercel log (`[auto-merge] squash-merged PR #N …`).
- The post-merge [[spec-test-on-ship]] is the safety net — a bad-but-green build surfaces as a regression via the existing flow (auto-merge doesn't re-judge the code).

### Phase 2 — auto-fold gate (Gate B) ⏳ (not yet built)
- A spec reaches shipped + agent-approved + all human checks resolved + no regressions → it auto-folds (batch fold-build) with no owner click; a spec with one waiting/failed human check or a regression → NOT folded.
- Negative: an agent-verdict-`issues` spec isn't folded.

## Phase 1 — auto-merge gate (extend the PR webhook) ✅
Shipped. The ready-PR auto-merge path lives in the [[../integrations/github-webhook|GitHub webhook]] alongside the dirty-PR detector — `autoMergeReadyPrs` in [[../libraries/github-pr-resolve]]: list open `claude/*` PRs → settle each PR's `mergeable` + `mergeable_state` (`fetchReadyPr`) → a READY PR (open · non-draft · `mergeable===true` · `mergeable_state==="clean"`, i.e. all checks green) is **squash-merged + branch-deleted** via the GitHub REST API (pinned to the evaluated head `sha`). **Serialized** (one merge per pass — the post-merge push webhook drives the next), **sync-aware** (`isInngestSyncActive` — no-op while a [[../tables/sync_jobs]] row is pending/running within 2 h), **kill-switched** (`isAutoMergeEnabled` reads `workspaces.auto_merge_enabled`, default ON). Webhook now also fires on `check_suite`/`check_run` completed + `status` success (the events that flip a PR green). **Control Tower:** registered as the `auto-merge-gate` reactive loop (`AUTO_MERGE_GATE_LOOP_ID`) — one `emitReactiveHeartbeat` per pass (ok:false on a failed merge → error-rate), every merged PR # in `produced` + a console log. Brain: [[dirty-pr-resolver-agent]] · [[../libraries/github-pr-resolve]] · [[../integrations/github-webhook]] · [[../libraries/control-tower]] · [[../tables/workspaces]] · [[../operational-rules]]. Migration `20260622180000_workspaces_auto_merge.sql` (apply: `scripts/apply-workspaces-auto-merge-migration.ts`).

## Phase 2 — auto-fold gate ⏳
Periodic + reactive check for fully-verified shipped specs → `enqueue_fold`, all-green guardrail, kill-switch, Control Tower registration + logging. Brain: [[spec-test-on-ship]] · [[../libraries/spec-test-runs]] · [[../libraries/control-tower]].
