# Surface regression coverage on the scorecard ⏳

**Owner:** [[../functions/platform]] · **Parent:** [[regression-agent]] — the standing-coverage complement to Remi; the regression-side sibling of [[director-zero-backlog-error-autonomy]] under [[../goals/devops-director]]

## North star — coverage is the supervisor's job

Remi optimizes 'review the regression in front of me.' The Director's job is to GUARANTEE coverage AND to make that coverage visible, so regression health is a measured KPI rather than a hope. This card covers the visibility half; the guarantee half ships under the parent.

## Phase 1 — surface it on the scorecard ⏳
- Feed the daily board-watch + the [[Platform Department Scorecard]] goal: 'regressions — D detected, F fixed, R reconciled from backlog, E escalated' + a 'shipped specs re-verified this week / total' coverage number, so regression coverage is a visible KPI, not a hope.
- Reconcile with the scorecard lane before building: [[../specs/platform-scorecard-weekly]] already owns a 'regressions caught' KPI and [[../specs/platform-scorecard-surface]] owns the page + board-watch line — extend those rather than build a parallel surface.

### Verification — Phase 1
- The board-watch + scorecard show the day's regression detect/fix/reconcile/escalate counts and the re-verification coverage ratio.