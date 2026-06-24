# Surface regression coverage on the scorecard ⏳

**Owner:** [[../functions/platform]] · **Parent:** [[regression-agent]] — the standing-coverage complement to Remi; the regression-side sibling of [[director-zero-backlog-error-autonomy]] under [[../goals/devops-director]]
**Deferred:** split from [[regression-backlog-reconciliation]] — not needed now: the parent's promise (guarantee coverage + drain the backlog) is delivered and runs autonomously by its shipped Phases 1 & 2; surfacing the counts on a scorecard is observability/KPI polish, not load-bearing for the reconciliation to work. It also overlaps an already-owned lane — the [[../goals/platform-department-scorecard]] goal's weekly milestone already lists 'regressions caught' — so this should align with (or fold into) [[../specs/platform-scorecard-weekly]] / [[../specs/platform-scorecard-surface]] rather than duplicate it.

## North star — coverage is the supervisor's job

Remi optimizes 'review the regression in front of me.' The Director's job is to GUARANTEE coverage AND to make that coverage visible, so regression health is a measured KPI rather than a hope. This card covers the visibility half; the guarantee half ships under the parent.

## Phase 1 — surface it on the scorecard ⏳
- Feed the daily board-watch + the [[Platform Department Scorecard]] goal: 'regressions — D detected, F fixed, R reconciled from backlog, E escalated' + a 'shipped specs re-verified this week / total' coverage number, so regression coverage is a visible KPI, not a hope.
- Reconcile with the scorecard lane before building: [[../specs/platform-scorecard-weekly]] already owns a 'regressions caught' KPI and [[../specs/platform-scorecard-surface]] owns the page + board-watch line — extend those rather than build a parallel surface.

### Verification — Phase 1
- The board-watch + scorecard show the day's regression detect/fix/reconcile/escalate counts and the re-verification coverage ratio.