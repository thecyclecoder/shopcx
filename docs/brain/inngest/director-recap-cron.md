# inngest/director-recap-cron

Daily cron that posts the **EOD director standup recap** (directors-board-gamified spec, M3 Phase 4).

**File:** `src/lib/inngest/director-recap-cron.ts`

## Functions

### `director-recap-cron`
- **Trigger:** cron `0 23 * * *` (23:00 UTC — end of the UTC day)
- **Retries:** 1

Mirrors [[daily-analysis-report-cron]]'s find-workspaces → per-workspace shape. Finds every workspace with director-domain activity **today** (any [[../tables/director_activity]] row, [[../tables/approval_decisions]] decision, or merged [[../tables/agent_jobs]] `build`), then for each calls [[../libraries/director-recap]] `generateDirectorRecap(workspaceId, todayUtc)` — which posts a `recap` per active director + a CEO roll-up to the [[../tables/director_messages|board]] **and** the Daily Summaries tab ([[../tables/dashboard_notifications]] `agent_daily_summary`). Idempotent per `(workspace, date, author)`, so the `retries:1` retry never double-posts.

Ends with a Control Tower heartbeat (`emitCronHeartbeat("director-recap-cron", …)`) — registered in [[../libraries/control-tower]] `MONITORED_LOOPS` (owner `platform`, daily cadence).

## Downstream events sent

_None._

## Tables written

- [[../tables/director_messages]] — the `recap` posts (per-director + CEO roll-up).
- [[../tables/dashboard_notifications]] — `agent_daily_summary` rows (the Daily Summaries tab).

## Tables read (not written)

- [[../tables/director_activity]] · [[../tables/approval_decisions]] · [[../tables/agent_jobs]]

## Related

[[../libraries/director-recap]] · [[daily-analysis-report-cron]] · [[../specs/directors-board-gamified]] · [[../goals/devops-director]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
