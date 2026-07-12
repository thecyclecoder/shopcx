# node-ancestry-sync-cron

`src/lib/inngest/node-ancestry-sync-cron.ts` — nightly backstop that keeps [[../tables/node_ancestry]] aligned with the [[../libraries/control-tower-node-registry|canonical node registry]]. The DB mirror is what makes `public.claim_agent_job` honor the kill-switch cascade ([[../specs/claim-rpc-kill-switch-enforcement]] Phase 1).

## Trigger

`cron: "15 3 * * *"` — nightly at 03:15 UTC. Off-hours; a failure is not a live outage (the RPC is fail-open) so we don't need to fire more often. The box worker syncs on every startup, so this cron only matters when the box has stayed up across a registry change.

## What it does

1. Calls [[../libraries/node-ancestry-sync]] `syncNodeAncestry()` — upserts every desired row from the frozen `NODES` graph, then deletes any stale rows the registry no longer covers.
2. Emits a heartbeat via [[../libraries/control-tower-heartbeat]] `emitCronHeartbeat('node-ancestry-sync-cron', …)` carrying `{ ok, upserted, deleted, detail }` so the [[control-tower-monitor]] can flag a persistent sync failure as its own tile.

## Invariants

- **FAIL-OPEN BY DESIGN.** A sync error just means `public.claim_agent_job` sees an out-of-date mirror; an unregistered kind falls through to the claim path anyway. The heartbeat's `ok:false` surfaces the persistent-failure case as an alert without breaking the box.
- **BACKSTOP, NOT PRIMARY.** The box worker's startup call is the primary sync path. This cron only exists to cover the long-uptime edge case.

## Related

[[../specs/claim-rpc-kill-switch-enforcement]] · [[../tables/node_ancestry]] · [[../libraries/node-ancestry-sync]] · [[../libraries/control-tower-node-registry]] · [[../tables/kill_switches]] · [[control-tower-monitor]]
