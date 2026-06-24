# Director escalations must reach the CEO inbox (logged-but-invisible bug) ⏳

**Owner:** [[../functions/platform]] · **Parent:** [[platform-director-agent]] — hardens the Phase-3 CEO-escalation plumbing (`escalateDiagnosisToCeo`) under [[../goals/devops-director]]
**Found in use 2026-06-24:** board-grooming escalated [[agent-outage-resilience]] P3 to the CEO at 02:03 (escalation_kind `groom_unsure`, dedupe_key `groom-unsure:agent-outage-resilience`, reasoning recorded in [[../tables/director_activity]]) — but there is NO matching [[../tables/dashboard_notifications]] row (verified by `metadata->>spec_slug` and `metadata->>escalation_kind`; zero notifications since 01:55). The escalation was logged and is INVISIBLE to the CEO. An escalation nobody can see is worse than none — it silently strands the decision (here, a partially-shipped spec's next phase) and breaks supervisability.

## Root cause

`escalateDiagnosisToCeo` ([[../libraries/platform-director]]) inserts the CEO-routed `dashboard_notifications` row and then `recordDirectorActivity`, but it does NOT check the notification insert's error — `await admin.from('dashboard_notifications').insert(...)` is unguarded. If that insert fails (constraint/RLS/shape), the error is swallowed, the function still records the `escalated` activity row, and still returns `{ emitted: true }`. The box logs 'escalated to CEO' and everyone believes it surfaced. Net: the audit ledger says escalated; the inbox shows nothing. (The grooming escalate branch in `scripts/builder-worker.ts` calls only `escalateDiagnosisToCeo`, so the helper is the single point to fix.)

## Phase 1 — make the surface reliable + verified ⏳
- In `escalateDiagnosisToCeo`: capture the notification insert's `{ error }`. If it failed, do NOT silently proceed — surface it: throw/return `{ emitted:false, error }` (and the caller logs a hard warning), and do NOT write the `escalated` activity row as if surfaced (so the dedup ledger doesn't mark a never-surfaced escalation as done). Only record the activity + return `emitted:true` once the notification row actually landed. Order it notification-first, activity-second, both checked.
- Keep the existing dedupe (one notification per `dedupe_key`), but the dedupe must key on a notification that ACTUALLY EXISTS — a logged-but-unsurfaced escalation must not suppress the retry.
- Brain: [[../libraries/platform-director]] (`escalateDiagnosisToCeo`) · [[platform-director-agent]] (Phase 3) · [[../tables/dashboard_notifications]] · [[../tables/director_activity]].

### Verification — Phase 1
- Trigger a groom_unsure escalation → BOTH an `escalated` director_activity row AND a CEO-routed `dashboard_notifications` row (Approval Request, deep-linking the spec) exist, exactly once. Re-run → no duplicate notification, but the first ALWAYS surfaces.
- Force the notification insert to fail (test) → `escalateDiagnosisToCeo` returns `emitted:false` and does NOT write a phantom 'escalated' activity row.

## Phase 2 — reconcile the already-swallowed escalations (backfill) ⏳
- A standing backstop in the director pass: find every `escalated` [[../tables/director_activity]] row with no live matching `dashboard_notifications` (by `dedupe_key`/`spec_slug`) and re-emit the CEO notification once. This retroactively surfaces the agent-outage-resilience P3 escalation (and any sibling) so the CEO can act on decisions that silently stranded.
- Best-effort, idempotent (re-emits once, then the dedupe holds), dormant until live+autonomous.

### Verification — Phase 2
- After the backstop runs, the agent-outage-resilience P3 'your call' escalation appears in the CEO inbox with its recorded reasoning + a deep-link to the spec. A second pass emits no duplicate.

## Note — separate from the verdict itself
This fixes VISIBILITY, not the grooming judgment. Whether P3 should have been escalated at all (vs. continued) is a coaching/posture question for the CEO — if the Director is coached to continue partially-shipped platform specs that check out, fewer of these reach the inbox in the first place. This spec ensures the ones that DO escalate are never silent.