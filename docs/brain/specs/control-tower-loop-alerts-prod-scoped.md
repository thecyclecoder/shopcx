# Scope Control Tower loop-alert writes to the production environment ✅

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] · **Verdict:** foreign-app-noise
**Repair-root-cause:** `src/lib/control-tower/monitor.ts::foreign-app-noise`
**Repair-signature:** `loop:claude-status-poll-cron`

Stop non-production (preview/branch) deploys from polluting the shared prod loop_alerts feed and waking the Repair Agent with phantom registered_not_firing alerts for crons that exist only on an unmerged branch. The Control Tower act loop (alert insert/update/resolve + owner paging + Repair enqueue) must run only on the canonical production deploy; every other env may build the read-only snapshot for its own dashboard but must never write to the shared feed.

## Problem (from Control Tower signature `loop:claude-status-poll-cron`)
claude-status-poll-cron triggered a registered_not_firing loop_alert, but that loop exists only on unmerged WIP branch #351 (agent-outage-resilience) — it is absent from HEAD's MONITORED_LOOPS, so the prod monitor cannot evaluate it. The alert was therefore written by a non-prod deploy of #351 whose branch-local registry includes the loop; actOnControlTowerSnapshot (src/lib/control-tower/monitor.ts:1079) inserts into the shared loop_alerts table with no environment guard, so any preview/branch deploy adding a MONITORED_LOOPS entry leaks phantom alerts into prod and triggers the Repair Agent. The cron code itself is correct (it emits heartbeats); the gap is purely capture-scoping.

**Likely target:** `src/lib/control-tower/monitor.ts`

## Phase 1 — close it ✅
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

**Shipped:** `runControlTowerMonitor()` (`src/lib/control-tower/monitor.ts`) now builds the read-only snapshot, then guards the entire act phase behind `isCanonicalProductionDeploy()` (= `process.env.VERCEL_ENV === "production"`). On a non-prod deploy it logs the env + evaluated loop count and returns `opened:0, resolved:0` **before** any `loop_alerts` insert/update/resolve, owner page, or Repair/coverage enqueue. The dashboard read path (`buildControlTowerSnapshot`, used by `/api/developer/control-tower`) is unchanged — every env still renders its own tiles. Brain page [[../libraries/control-tower]] updated.

## Verification
- On a preview/branch deploy whose `MONITORED_LOOPS` includes a loop absent from prod HEAD, let `control-tower-monitor` fire → expect NO new `loop_alerts` row in the shared feed, NO owner Slack page, NO `repair`/`coverage-register` `agent_jobs`, and the cron log line `[control-tower] non-production deploy (VERCEL_ENV=…) — … skipping act loop`.
- On the canonical production deploy (`VERCEL_ENV=production`), let `control-tower-monitor` fire on a genuinely-red loop → expect the de-duped `loop_alerts` insert + owner page + `loop:<id>` Repair enqueue to land exactly as before (no behavior regression).
- Re-trigger the originating condition (signature `loop:claude-status-poll-cron`) from a non-prod deploy → expect no new `error_events` row / `loop_alert` for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `loop:claude-status-poll-cron` (verdict: foreign-app-noise). Commission the build from the Control Tower / Roadmap board.
