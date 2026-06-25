# Director escalations must surface to the CEO — backfill the already-swallowed ones ✅

**Owner:** [[../functions/platform]] · **Parent:** [[platform-director-agent]] — closes the loop on a known incident class: director escalations that wrote `director_activity` rows but never produced a matching CEO `dashboard_notifications` row. Going-forward swallowing is already closed by the source fix; this spec backfills the historic loss. Authored from context to match the existing `spec_card_state` row (the markdown step never ran the first time).
**Blocked-by:** —

The director-escalations path (groom / init / repair-dismissal / approval lanes escalating to the CEO) is supposed to write a `director_activity` row AND a `dashboard_notifications` row of `type='agent_escalation'`. Audit of recent passes found a class of escalations where the `director_activity` row landed but the matching CEO notification never did (a now-fixed branch in the surface code silently swallowed them). Result: the CEO never saw real diagnoses the director surfaced, and there's no in-product replay.

## Phase 1 — reconcile the already-swallowed escalations (backfill) ✅
- One-shot reconcile script `scripts/reconcile-swallowed-escalations.ts` (idempotent, dry-run by default, `--apply` to write; **not** `_`-prefixed — it's an executed operational artifact, so it stays in the repo for audit and isn't dropped by `.gitignore` `scripts/_*`). Bootstraps `createAdminClient()` per `script-conventions`.
- Pull every `director_activity` row `kind='escalated'` from the last 30 days across every workspace. LEFT JOIN against `dashboard_notifications` on `metadata.director_activity_id = director_activity.id` filtered to `type='agent_escalation'`. Every left-side row with NO right-side match is a swallowed escalation.
- For each swallowed row: insert the missing `dashboard_notifications` row carrying the original payload (reason, diagnosis, lane, `agent_job_id`, owning `director_function`) AND `metadata.backfill=true` + `metadata.backfilled_from_director_activity_id=<da.id>` so the CEO knows this card is a replay rather than a fresh issue.
- Stamp the reconciled `director_activity` row's `details.backfilled_notification_id=<new id>` so a re-run never double-replays.
- Print the per-workspace count to the worker log + post a one-line `#cto-ada` Slack message: `Backfilled N swallowed director escalations from the last 30 days; they're in your inbox now.`
- (Going-forward swallowing is already prevented by the source-side fix that closed the branch — this spec is the backfill, NOT the source repair.)

## Verification
- On the build box, `npx tsx scripts/reconcile-swallowed-escalations.ts` (no flags) → expect a dry-run report: total examined, swallowed count, per-workspace breakdown, and a `WOULD backfill` line per swallowed row. Zero DB writes.
- On the build box, `npx tsx scripts/reconcile-swallowed-escalations.ts --apply` → expect each swallowed escalation to land as a `dashboard_notifications` row with `type='agent_approval_request'`, `metadata.backfill=true`, `metadata.backfilled_from_director_activity_id=<da.id>`, `metadata.escalated_by_director='platform'`, `metadata.routed_to_function='ceo'`, and the source `director_activity` row stamped with `metadata.backfilled_notification_id=<new id>` + `metadata.backfilled_at`.
- Re-run `npx tsx scripts/reconcile-swallowed-escalations.ts --apply` immediately → expect "inserted 0 / stamped 0" (the backfilled notification carries the same `dedupe_key` AND the activity row carries the `metadata.backfilled_notification_id` stamp — both idempotency rails).
- On Superfoods (workspace `fdc11e10-b89f-4989-8b73-ed6526c4d906`), the dry-run line `workspace fdc11e10-…: N swallowed escalation(s) to backfill` prints the count before any live `--apply` is run.
- After the live `--apply`, the workspace's `#cto-ada` channel receives one Ada message: `Backfilled N swallowed director escalations from the last 30 days; they're in your inbox now.` (skipped with a console note if the workspace has no `slack_ada_channel_id`).
- On `/dashboard/agents` (CEO inbox) for an affected workspace, each backfilled card renders Ada's escalation with a deep link to the spec/goal, distinguishable by the `(replayed backfill)` line in the body.
- `npx tsc --noEmit` clean.
