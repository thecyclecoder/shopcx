# organic-nugget-generate (`organicNuggetGenerate`)

Daily cron that keeps each enabled workspace's organic **nugget carousel** queue filled. Added in organic-nugget-engine Phase 3. Source: `src/lib/inngest/organic-nugget-generate.ts`.

## Trigger

- Cron `0 7 * * *` (daily) + event `organic/nugget.tick` (manual/targeted; optional `{ workspace_id, target }`).
- `concurrency: 1`.

## What it does

For every workspace with `social_scheduler_config.enabled`, calls [[../libraries/nugget-generator]] `topUpNuggetQueue(ws, 7)` — generates nugget carousels across the three pillars until ≥7 draft-or-approved carousels are queued (≤3 minted per run). Inserts land as **drafts** via the organic SDK (supervisable autonomy: it proposes, a human approves in Marketing › Social).

## Writes

- [[../tables/organic_content]] (format=`carousel`, status=`draft`) via [[../libraries/organic-content]] `insertOrganicContentDraft`.
- [[../tables/loop_heartbeats]] — end-of-run `emitCronHeartbeat("organic-nugget-generate", …)`.

## Node trio (CLAUDE.md hard rule)

- **Owner:** `cmo` — MONITORED_LOOPS row in [[../libraries/control-tower]] `registry.ts` (daily cadence, 30h liveness window).
- **Kill switch:** the `cmo` / social ancestor (same ancestry as `social-scheduler-plan` + `featured-review-cards`).
- **Heartbeat:** `emitCronHeartbeat` at end of run.
- Registered in `src/lib/inngest/registered-functions.ts`.

## Related

[[../libraries/nugget-generator]] · [[../tables/organic_content]] · [[../lifecycles/social-scheduler]] · [[../functions/cmo]]
