# inngest/mario-stall-cron

Mario's M3 detector tick ([[../specs/spec-mario-stall-detector-cron-and-thresholds]] · [[../goals/mario-pipeline-plumbing]] M3). Every minute it iterates workspaces, calls [[../libraries/mario]] `evaluateStalledSpecs` per workspace to find specs whose next lifecycle step is genuinely overdue (deterministic — reads [[../tables/mario_thresholds]] + [[../tables/spec_timecard_events]] + [[../libraries/brain-roadmap]] `getSpecBlockers`), and enqueues one dedupe-guarded `kind='mario'` [[../tables/agent_jobs]] row per candidate. Runs in the Vercel/Inngest runtime alongside deploy-guardian-cron — no box token burn.

**File:** `src/lib/inngest/mario-stall-cron.ts` · logic in [[../libraries/mario]] · SDK reads [[../libraries/spec-timecards]] · thresholds in [[../tables/mario_thresholds]]

## Functions

### `mario-stall-cron`
- **Trigger:** cron `* * * * *` (every minute)
- **Config:** `retries: 1` — the next tick re-evaluates a minute later; no value in long retries. The evaluator is idempotent (reads only) and the enqueue is dedupe-guarded, so a double-fire is safe.
- **What it does:** for every workspace, calls `evaluateStalledSpecs(admin, workspace_id)` — reads every `mario_thresholds` row, per row calls [[../libraries/spec-timecards]] `listStalledCandidates` with `older_than_ms=row.sla_ms`, keeps candidates whose `last_event_kind === from_event`, then drops candidates blocked by an uncleared spec blocker / a live job in `blocked_on_*` / `needs_input` / `needs_approval` / a `specs.status IN ('folded','deferred')` override (the legit-wait discriminator lives in the library). Every survivor gets a `MarioBrief` attached (last 10 timecard events + blockedBy state + current job status). Then for each candidate calls `enqueueMarioJob(admin, candidate)` — SELECT for an active mario row on the same `(workspace_id, spec_slug)`; if none, INSERT a `kind='mario', status='queued', instructions=JSON.stringify(brief)` row. Per-tick cap of 25 enqueues (mirrors deploy-guardian-cron's bounded tick) so a massive backlog doesn't overwhelm the mario lane.
- **Self-monitoring:** emits a `mario-stall-cron` heartbeat at the end (`emitCronHeartbeat`). `ok` = the tick completed; a dedupe hit is a product signal, not a cron failure. Registered in `src/lib/control-tower/registry.ts` once M4 lands so a dead evaluator shows as a stale cron tile.
- **Returns** `{ candidates_evaluated, jobs_enqueued, jobs_deduped, cap_reached }` — every field logged per tick so the M4 self-tuner + a human operator can watch the lane's throughput.

## Downstream events sent

_None._ Side effects are the new `kind='mario'` [[../tables/agent_jobs]] rows (one per surviving, non-dedupe-blocked candidate) and the end-of-tick heartbeat in [[../tables/loop_heartbeats]]. The M4 reasoning agent (out of this spec's scope; the follow-on milestone) picks up the queued mario rows and drives the actual response — the cron only surfaces WHAT is stalled, never WHAT TO DO.

## Tables written

- [[../tables/agent_jobs]] (one `kind='mario', status='queued'` row per stalled candidate — dedupe-guarded by [[../libraries/mario]] `enqueueMarioJob` so a spec_slug can't have two live mario rows at once)
- [[../tables/loop_heartbeats]] (its own end-of-run beat via `emitCronHeartbeat`)

## Tables read

- [[../tables/mario_thresholds]] (every row, per workspace — the M4 self-tuner's SLA output)
- [[../tables/spec_timecard_events]] (via [[../libraries/spec-timecards]] `listStalledCandidates`)
- [[../tables/specs]] + [[../tables/spec_phases]] (via [[../libraries/specs-table]] `getSpec` — the fold-cooldown / deferred override check)
- [[../tables/agent_jobs]] (the live-status check per candidate + the dedupe SELECT)
- [[../tables/workspaces]] (the per-tick iteration source)

## Dedupe contract

One active mario job per spec_slug. `enqueueMarioJob` filters on `.eq("workspace_id", …).eq("kind", "mario").eq("spec_slug", …).in("status", ACTIVE_STATUSES)` — an existing hit short-circuits with `{ enqueued: false, reason: "active_mario_exists" }` and is counted as `jobs_deduped` on the tick's return. This makes a second cron tick against an already-flagged stall a no-op, which the spec's Verification calls out explicitly.

## Callers

- Inngest scheduler (cron trigger).
- Registered via `src/lib/inngest/registered-functions.ts` (`registeredInngestFunctions` — the array `/api/inngest` spreads verbatim), so the function deploys on every Vercel deploy.

## Related

[[../libraries/mario]] · [[../tables/mario_thresholds]] · [[../tables/spec_timecard_events]] · [[../libraries/spec-timecards]] · [[../libraries/specs-table]] · [[../libraries/brain-roadmap]] · [[../tables/agent_jobs]] · [[../specs/spec-mario-stall-detector-cron-and-thresholds]] · [[../goals/mario-pipeline-plumbing]] · [[deploy-guardian-cron]]
