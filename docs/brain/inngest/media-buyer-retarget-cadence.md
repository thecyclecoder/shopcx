# media-buyer-retarget-cadence

`src/lib/inngest/media-buyer-retarget-cadence.ts` — the daily cron that drives the Media Buyer's THIRD (retarget) campaign replenish ([[../specs/retarget-campaign-warm-hot-mixed-content]] Phase 3).

## Trigger

- **Cron** `30 13 * * *` (daily). Inngest function id: `media-buyer-retarget-cadence`.

## What it does

Loads every ACTIVE [[../tables/meta_ad_accounts]] row (each carries its `workspace_id`) and, per account, calls [[../libraries/media-buyer-retarget-agent]] `runRetargetReplenishLoopForAccount(workspace, account)`. That loop resolves the account's active [[../tables/media_buyer_retarget_cohorts]] rows (one pass per product cohort), reads WARM + HOT ready creatives via [[../libraries/ready-to-test]] `listReadyToTest` scoped to the cohort's `audience_temperatures` whitelist, and publishes each passer into the ONE consolidated retarget adset through [[../libraries/media-buyer-retarget-publish-gate]] `evaluateMediaBuyerRetargetPublish`.

Unlike the cold-rail [[media-buyer-cadence]] (`media-buyer-cadence-cron`, which fans out `agent_jobs` for the box worker), this rail runs the deterministic replenish loop **inline** — it mints no per-test adsets and moves no scale/kill dollars, so there is no box-session reasoning to dispatch.

**The cold-only invariant of Bianca's existing replenish loop is UNTOUCHED** — this cron reads only `media_buyer_retarget_cohorts` and warm/hot creatives; the cold test rail (`temperature: "cold"` in [[../libraries/media-buyer-agent]]) is byte-unchanged.

## Writes

- `ad_publish_jobs` rows (`origin='media-buyer-retarget'`, `publish_active=true`, `meta_adset_id` = the consolidated retarget adset) for every gate-allowed warm/hot creative, then fires `ad-tool/publish-to-meta`.
- `director_activity` — one `media_buyer_retarget_pass_completed` heartbeat per pass; one `media_buyer_retarget_publish_refused` escalation per gate refusal (written by the gate).

## Node completeness (CLAUDE.md hard rule)

- **Owner** `growth` — the `media-buyer-retarget-cadence` MONITORED_LOOPS row in `src/lib/control-tower/registry.ts` + the `media_buyer_retarget` `KIND_OWNER_FALLBACK` entry in `src/lib/control-tower/node-registry.ts`.
- **Kill-switch** — ancestor `growth` department row in [[../tables/kill_switches]] (the cascade resolves any child owned by growth).
- **Heartbeat** — `emitCronHeartbeat("media-buyer-retarget-cadence", …)` at end-of-run.
- **Monitor cadence invariant** — daily cadence ⇒ 30h liveness window (`108000000` ms) so `assertRegistryInvariants` passes.

## Registration

Exported `mediaBuyerRetargetCadenceCron`, registered in `src/lib/inngest/registered-functions.ts`.

## Related

[[../tables/media_buyer_retarget_cohorts]] · [[../tables/meta_ad_accounts]] · [[../libraries/media-buyer-retarget-agent]] · [[../libraries/media-buyer-retarget-cohort]] · [[../libraries/media-buyer-retarget-publish-gate]] · [[media-buyer-cadence]] · [[../reference/meta-scaling-methodology]] · [[../specs/retarget-campaign-warm-hot-mixed-content]] · [[../functions/growth]]
