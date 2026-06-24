# Deploy-Health & Auto-Rollback guardian ⏳

**Owner:** [[../functions/platform]] · **Parent:** [[../functions/platform]] Infra & DevOps / reliability mandate — the safety net that makes the auto-merge in [[director-zero-backlog-error-autonomy]] safe, under [[../goals/devops-director]]
**Found in use 2026-06-24:** the CEO wants to never handle routine errors, which means the director auto-merges fixes ([[director-zero-backlog-error-autonomy]]). But the current worker roster owns build → verify → fold, NOT post-deploy health + rollback. Bo merges, Vera checks a spec's own verification, Tao watches loops — none owns 'this deploy just went live; did it regress prod, and revert it fast if so.' Auto-merge without auto-rollback is the unguarded half.

## North star — the supervisor for the auto-merge proxy

Auto-merge optimizes 'ship the fix.' Its degenerate state is shipping a fix that breaks something else and leaving it live. This guardian is the supervisor on that proxy: restore known-good FAST on a clear deploy-correlated regression (the conservative action — a revert is itself reversible), and escalate anything ambiguous rather than guess. It supervises the existing deploy/error/loop signals; it does not replace them.

## The agent — a new DevOps worker (persona reskinnable)
A new `agent_jobs` lane / control-tower agent-kind tile, under the DevOps Director, in the Workers roster + org chart with a profile + responsibilities (mirrors [[../specs/regression-agent|Remi]] / [[../specs/coverage-auto-register-agent|Cole]]). Proposed name: **Reva — Deploy Guardian** (🔁).

## Phase 1 — watch each auto-merged deploy over a canary window ⏳
- On a deploy triggered by an auto-merged `claude/<slug>` PR (the director's auto-fix path), open a `deploy-watch` over a bounded canary window (e.g. 10–15 min): sample new [[../tables/error_events]] signatures + [[../tables/loop_alerts]] + the [[../dashboard/control-tower]] snapshot, attributing only errors that FIRST appear after the deploy timestamp (the correlation gate, mirroring [[../specs/agent-outage-resilience]]'s outage-correlation tagging).
- Verdict per deploy: `healthy` (no new deploy-correlated regression → mark the deploy good, log it) · `regressed` (a clear spike of NEW errors / a loop flipping red, correlated to this deploy) · `unsure` (ambiguous → escalate, never auto-act).
- Reuses Tao's Control-Tower signals + the error-feed; no new monitoring substrate.
- Brain: new `libraries/deploy-guardian` + `inngest/deploy-guardian` (or box-lane) pages, [[../libraries/control-tower]], [[../tables/error_events]], [[../tables/loop_alerts]].

### Verification — Phase 1
- A clean auto-merged deploy → a `healthy` verdict + a logged deploy-watch, no action. A deploy that introduces a new correlated error signature → a `regressed` verdict surfaced within the canary window.

## Phase 2 — auto-rollback to known-good + escalate ⏳
- On `regressed`: restore known-good — `git revert` the offending merge (or roll back the Vercel deployment to the prior good build) — then escalate the diagnosis to the director/CEO via the Phase-3 escalation plumbing (carrying what regressed + the revert). This is within the leash: restoring a known-good state is the CONSERVATIVE, reversible action (revert-of-a-revert re-applies it). Anything the guardian can't cleanly attribute to the deploy → `unsure` → escalate, move nothing.
- Loop-guard: if the same slug regresses on rollback-then-reland twice, stop auto-relanding and escalate a 'deeper issue' (mirrors `PLATFORM_DIRECTOR_LOOP_GUARD_MAX`).
- Writes a `deploy_rolled_back` / `deploy_healthy` [[../tables/director_activity]] row so it shows in the board-watch + the KPI scorecard.

### Verification — Phase 2
- A deploy-correlated regression → an automatic revert restoring the prior good build + a CEO/director escalation with the diagnosis + a `deploy_rolled_back` activity row. An ambiguous case → escalated, NOT auto-reverted. Re-landing the same slug that regresses twice → loop-guard escalation, no infinite reland.

## Open decision (for the CEO)
Rollback aggressiveness: auto-revert on any deploy-correlated NEW-error spike (fastest protection, default here), vs. auto-revert only when a customer-facing loop goes red and merely escalate on a non-customer error spike. Default is the former (protect prod first; a revert is cheap and reversible); say the word to scope auto-revert to customer-facing regressions only.