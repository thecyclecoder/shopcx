# Re-opened cluster:repair job loses its batched members (director-bounce empties the cluster) ⏳

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]]; fixes the re-open path in [[../specs/director-supervised-repair-dismissal]] · **Verdict:** real-bug
**Repair-root-cause:** `src/lib/repair-agent.ts (add optional members to enqueuerepairinput and persist it onto the inserted cluster jobs instructions when source===cluster) + src/app/api/developer/control-tower/repair/route.ts (reopen handler: parse the dismissed jobs instructions.members and pass them through)::real-bug`
**Repair-signature:** `cluster:repair`

When a `cluster:repair` job is director-dismissed and then owner-re-opened, the re-enqueue must carry the original batched `members` so the re-triage has the same cluster to investigate instead of an empty '0 signatures' brief. Today the members payload is dropped on re-enqueue, wasting a full repair pass on nothing.

## Problem (from Control Tower signature `cluster:repair`)
src/app/api/developer/control-tower/repair/route.ts (reopen handler, ~line 82) re-enqueues a dismissed cluster job via enqueueRepairJob passing only source/signature/title/errorEventId/loopAlertId. enqueueRepairJob's EnqueueRepairInput and its standard insert (src/lib/repair-agent.ts ~line 194) have no `members` field — members are written ONLY in foldIntoClusterJob. Because signature 'cluster:repair' is excluded from the burst counter, the re-enqueue takes the standard insert, writing instructions with no members. loadRepairBrief (scripts/builder-worker.ts ~line 5505) then sees source==='cluster' with members=[] and emits 'CLUSTER — 0 signatures batched', so the 7 batched signatures are lost and the re-triage is a no-op.

**Likely target:** `src/lib/repair-agent.ts (add optional `members` to EnqueueRepairInput and persist it onto the inserted cluster job's instructions when source==='cluster') + src/app/api/developer/control-tower/repair/route.ts (reopen handler: parse the dismissed job's instructions.members and pass them through)`

## Phase 1 — close it ⏳
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

## Verification
- Re-trigger the originating condition (signature `cluster:repair`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `cluster:repair` (verdict: real-bug). Commission the build from the Control Tower / Roadmap board.
