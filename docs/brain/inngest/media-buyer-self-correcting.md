# inngest/media-buyer-self-correcting

The daily cron + per-workspace sweep that auto-flips an armed Media Buyer cohort back to `shadow` when its 14-day [[../tables/media_buyer_action_grades]] rolling per-day average slips below the sound-call threshold for a sustained streak ([[../specs/media-buyer-self-correcting-mode-revert]] Phase 1 — closing the [[../goals/autonomous-media-buyer-supervision]] M4 "Graded + self-correcting" loop). Fires 30 min after [[media-buyer-grade]] so the sweep reads settled per-day grades.

**File:** `src/lib/inngest/media-buyer-self-correcting.ts` · detector + revert in [[../libraries/media-buyer-self-correcting]]

## Functions

### `media-buyer-self-correcting-cron`
- **Trigger:** cron `30 14 * * *` (once daily at 14:30 UTC — 30 min after the [[media-buyer-grade]] pass so any freshly-scored grades are readable)
- **Concurrency:** `concurrency: [{ limit: 1 }]`, `retries: 1`
- **What it does:** reads the distinct armed workspaces from [[../tables/iteration_policies]] (`status='active' AND mode='armed' AND campaign_id IS NULL`) and fans out one `growth/media-buyer-self-correcting-sweep` event per workspace. End-of-run heartbeat via `emitCronHeartbeat("media-buyer-self-correcting-cron", …)`.
- **Returns** `{ workspaces }` (count fanned out).

### `media-buyer-self-correcting-sweep`
- **Trigger:** event `growth/media-buyer-self-correcting-sweep` (data: `{ workspace_id, trigger? }`)
- **Concurrency:** `concurrency: [{ limit: 1, key: "event.data.workspace_id" }]`, `retries: 1`
- **What it does:** finds the distinct `(meta_ad_account_id | null)` cohorts for the workspace via [[../libraries/media-buyer-self-correcting]] `findCohortMetaAdAccountIds` (from the joined [[../tables/director_activity]] `metadata.meta_ad_account_id` over the 14-day lookback), then calls [[../libraries/media-buyer-self-correcting]] `checkMediaBuyerRegressionAndDisarm` per cohort. Each call is idempotent — an already-shadow workspace no-ops.
- **Returns** `{ status:"complete", workspace_id, checked, disarmed, errors }`.

## Idempotency

The detector reads the current `iteration_policies.mode` before mutating — a re-run against an already-shadow policy returns `{ disarmed: false, reason: 'not_armed' }` and DOES NOT re-emit a director_activity row nor a CEO card. The CEO card is additionally dedup-scoped in [[../libraries/platform-director]] `escalateDiagnosisToCeo` by `dedupeKey='media_buyer_regressed_disarmed:{ws}:{acct|_workspace_}'`.

## North-star invariant

The revert is a **supervised revert** ([[../operational-rules]] § North star): the tool (the Media Buyer) proxies ROAS; the objective-owner (the CEO) owns "am I actually winning?" A sustained grade regression IS the signal that the proxy has drifted, so the tool self-reverts AND surfaces the escalation — the CEO card is the objective-owner's read. No silent proxy-optimizing.

## Downstream events sent

- `growth/media-buyer-self-correcting-sweep` (one per armed workspace, from the cron's fan-out)

Downstream side effects from the sweep are conditional (only when a cohort trips the streak):

- One [[../tables/iteration_policies]] mode flip (`armed` → `shadow`, via the shared [[../libraries/media-buyer__mode-flip]] compare-and-set).
- One [[../tables/director_activity]] `media_buyer_self_disarmed` row (director_function='growth').
- One [[../tables/dashboard_notifications]] approval-request CEO card, deduped by `media_buyer_regressed_disarmed:{ws}:{acct|_workspace_}`.

## Tables read (not written)

- [[../tables/iteration_policies]] (armed-workspace discovery + per-cohort current-mode read)
- [[../tables/media_buyer_action_grades]] (14-day lookback of `overall_grade` + `graded_at`, joined `!inner` on [[../tables/director_activity]] for the `meta_ad_account_id` filter)
- [[../tables/director_activity]] (joined for `metadata.meta_ad_account_id`)

## Tables written

- [[../tables/iteration_policies]] (mode flip on regression trip — via [[../libraries/media-buyer__mode-flip]])
- [[../tables/director_activity]] (one `media_buyer_self_disarmed` row per disarm)
- [[../tables/dashboard_notifications]] (one CEO-routed card per disarm, deduped by the `media_buyer_regressed_disarmed:{ws}:{acct|_workspace_}` key)
- [[../tables/loop_heartbeats]] (its own end-of-run beat)

## Register-or-it's-incomplete

Registered in `src/lib/control-tower/registry.ts` as a `cron` loop owned by `growth` (`livenessWindowMs` 26h, `registeredAt: 2026-07-09T14:30:00Z` for the newcron-grace) — per [[../operational-rules]], a new cron is incomplete without a Control Tower entry + an end-of-run heartbeat.

## Related

[[../libraries/media-buyer-self-correcting]] · [[../libraries/media-buyer__mode-flip]] · [[../libraries/media-buyer-grader]] · [[../libraries/platform-director]] · [[media-buyer-grade]] · [[media-buyer-cadence]] · [[../tables/iteration_policies]] · [[../tables/media_buyer_action_grades]] · [[../tables/director_activity]] · [[../tables/dashboard_notifications]] · [[../specs/media-buyer-self-correcting-mode-revert]] · [[../goals/autonomous-media-buyer-supervision]] · [[../functions/growth]]
