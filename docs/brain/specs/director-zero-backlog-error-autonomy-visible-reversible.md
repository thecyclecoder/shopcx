# Error autonomy visible + reversible — the nightly error-autonomy rollup

**Owner:** [[../functions/platform]] · **Parent:** [[platform-director-agent]] — the error-autonomy capstone over [[../libraries/repair-agent]] under [[../goals/devops-director]]

## Phase 1 — the autonomy is visible + reversible (your supervision over me)
- A daily [[../libraries/platform-director]] board-watch rollup: 'errors tonight — F fixed & shipped, D dismissed-benign, R reconciled from backlog, E escalated to you as external.' Each auto-merged fix is a normal `claude/<slug>` PR with the verification trail, so any one is one `git revert` away. You get after-the-fact visibility and an instant undo without being in the loop up front.

### Verification — Phase 1
- After a day of error activity, ONE board-watch post summarizes fixed/dismissed/reconciled/escalated counts; each auto-fix is a revertable PR with its CI + spec-test trail.