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
- Open a clean `claude/*` build PR with green checks → it auto-squash-merges + deletes the branch within the webhook window; a CONFLICTING one is NOT merged (goes to the dirty-PR-resolver); a human PR is never touched.
- Two ready PRs at once → they merge **serially** (not two simultaneous deploys); during an active Inngest sync, merges defer.
- A spec reaches shipped + agent-approved + all human checks resolved + no regressions → it auto-folds (batch fold-build) with no owner click; a spec with one waiting/failed human check or a regression → NOT folded.
- Both gates appear as green monitored loops in the Control Tower; each merge/fold is logged. Flip the kill-switch → the gate stops acting.
- Negative: a red-check PR isn't merged; an agent-verdict-`issues` spec isn't folded.

## Phase 1 — auto-merge gate (extend the PR webhook) ⏳
Add the ready-PR auto-merge path to the dirty-PR-resolver's webhook handler (claude/* + mergeable + green → serialized squash-merge, sync-aware), the kill-switch, Control Tower registration + logging. Brain: [[dirty-pr-resolver-agent]] · [[../libraries/control-tower]] · [[../operational-rules]].

## Phase 2 — auto-fold gate ⏳
Periodic + reactive check for fully-verified shipped specs → `enqueue_fold`, all-green guardrail, kill-switch, Control Tower registration + logging. Brain: [[spec-test-on-ship]] · [[../libraries/spec-test-runs]] · [[../libraries/control-tower]].
