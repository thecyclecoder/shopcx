# Director-owned error autonomy: every error self-fixes or escalates as external ⏳

**Owner:** [[../functions/platform]] · **Parent:** [[platform-director-agent]] — the error-autonomy capstone over [[../libraries/repair-agent]] under [[../goals/devops-director]]
**Found in use 2026-06-24:** the CEO wants to never handle errors unless they're genuinely unfixable by us — 'if there's a backlog, those should have specs made and fixed; only pull me in when something outside our system is broken and we need alternatives.' Today: 16 open `error_events`, 2 `repair` jobs in `needs_attention` awaiting manual dismiss, 2 open `loop_alerts`. Rafa ([[../libraries/repair-agent]]) is event-triggered (fires on a NEW signature) and authors fixes, but nothing GUARANTEES the existing open backlog drains, and 'needs a human' is not distinguished from 'external blocker, needs the CEO.'

## North star — autonomous, but supervised by construction

Auto-building product-code fixes off a noisy error feed is the exact Goodhart failure [[../libraries/repair-agent]] warns about. So 'the CEO never touches errors' is delivered WITHOUT removing the rails: every auto-fix clears the verification gate (tsc + CI + [[../specs/spec-test-agent|spec-test]]/[[../libraries/regression-agent|regression]]) before merge, one root cause collapses to one fix (the repair dedup), and a fix that fails ≥ `PLATFORM_DIRECTOR_LOOP_GUARD_MAX` stops and escalates a 'deeper issue' instead of looping. The Director SUPERVISES the repair tool to a terminal state; it does not blind-merge.

## Phase 1 — zero-backlog reconciliation (every open error reaches a terminal state) ✅
- Add `reconcileErrorBacklog(admin)` to [[../libraries/platform-director]], run in `runPlatformDirectorStandingPass`, dormant until live+autonomous. Each pass: read every OPEN [[../tables/error_events]] row + OPEN [[../tables/loop_alerts]] incident, and classify against the live [[../tables/agent_jobs]] state — (a) a fix already in-flight/merged-pending-deploy → confirm, leave it; (b) no live repair job and no fix spec → `enqueueRepairJob` so Rafa diagnoses + authors (then the fix-escort auto-builds it, [[director-initialize-platform-specs-no-wait]]); (c) Rafa already authored a fix spec that's unbuilt → ensure the fix-escort/groom picked it up; (d) stuck (failed ≥ loop-guard) → escalate. Bounded per pass (a cap like the groom cap), reuses the repair dedup (no double-enqueue), idempotent.
- Net: the open-error count trends to zero on its own — a backlog item that slipped the event trigger (outage window, pre-live, a skip) now has a standing owner re-driving it. Writes a `reconciled_error` [[../tables/director_activity]] row per action.
- Brain: [[../libraries/platform-director]] · [[../libraries/repair-agent]] (`enqueueRepairJob`, the dedup) · [[../tables/error_events]] · [[../tables/loop_alerts]].

### Verification — Phase 1
- With Platform live+autonomous, an OPEN error_events row with no live repair job + no fix spec gets a `repair` job enqueued on the next standing pass (and, downstream, an auto-built fix), plus a `reconciled_error` activity row. The current 16-open backlog trends down across passes.
- An error already covered by an in-flight fix is NOT re-enqueued (dedup). A signature Rafa resolved as transient is not re-opened.

## Phase 2 — the external-blocker escalation class (the ONLY routine CEO touch) ✅
- Make 'the root cause is OUTSIDE our system' a first-class outcome, distinct from internally-fixable. When the verified diagnosis is an external dependency break (a third-party API contract change, a vendor outage beyond our retry/breaker, a credential/permission change on their side), the Director does NOT author a code fix — it `escalateDiagnosisToCeo` with the diagnosis + 2–3 concrete ALTERNATIVE options (wait/retry, swap provider, degrade gracefully). Everything internally-fixable is fixed without the CEO.
- This refines the `needs-human` verdict + the [[../specs/agent-outage-resilience]] outage-aware path: 'needs a human judgment we can make internally' → I take it (author/build or supervised-dismiss); 'needs the CEO because it's external and needs a business call' → the only routine escalation. Deduped per signature so it pings once.

### Verification — Phase 2
- An error whose verified root cause is an external vendor break → a single CEO escalation carrying the diagnosis + alternative options + an `escalated` row; NO code fix authored. An internally-fixable error → fixed end-to-end, the CEO never sees it.

## Phase 3 — the autonomy is visible + reversible (your supervision over me) ⏳
- A daily [[../libraries/platform-director]] board-watch rollup: 'errors tonight — F fixed & shipped, D dismissed-benign, R reconciled from backlog, E escalated to you as external.' Each auto-merged fix is a normal `claude/<slug>` PR with the verification trail, so any one is one `git revert` away. You get after-the-fact visibility and an instant undo without being in the loop up front.

### Verification — Phase 3
- After a day of error activity, ONE board-watch post summarizes fixed/dismissed/reconciled/escalated counts; each auto-fix is a revertable PR with its CI + spec-test trail.

## Open decision (for the CEO)
Full autonomy means auto-MERGING product-code fixes once CI + verification are green — no glance from you. That matches 'I don't want to intervene,' and the safety is the verification gate + the one-tap revert. Alternative: auto-build but HOLD the merge for your one-tap confirm on anything touching customer-facing paths. Default in this spec is auto-merge-on-green (you're out of the loop); say the word and I'll gate the merge for customer-facing code only.