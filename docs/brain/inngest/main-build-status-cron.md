# main-build-status-cron — the red-main pipeline alarm's monitored loop body

Every 15 minutes it reads the combined build status of main's HEAD commit, and on failure identifies the FIRST red commit and raises a CEO-visible alarm — idempotent per `first_red_sha` so a per-tick sweep can't fan out a new card each tick for the same breakage. On success it clears any open alarm. Emits an end-of-run `emitCronHeartbeat` so a dead detector is itself visible via the Control Tower.

**Spec:** [[../specs/a-red-main-is-a-first-class-pipeline-alarm]] Phase 1

**Owner:** [[../functions/platform]] — Ada (CTO / Platform director)

**Trigger:** Inngest cron `*/15 * * * *` — every 15 minutes.

**Wiring:**
- Registered in `src/lib/inngest/registered-functions.ts` as `mainBuildStatusCron`.
- Tied to the `main-build-status` MONITORED_LOOPS row (owner: `platform`, 45m liveness window, registered at `2026-08-31T00:00:00Z` grace) in [[../control-tower-node-registry]].
- Inherits [[../tables/kill_switches]] ancestry via `parentIdForOwner('platform') → 'director:platform'` — node-completeness verified by `assertRegistryInvariants`.
- Emits `emitCronHeartbeat('main-build-status', …)` in a `finally` block so a dead detector is itself visible.

## Function body

The Inngest function wraps `sweepMainBuildStatus()` from [[../control-tower/main-build-status]] with heartbeat telemetry. On any exception it logs the error and re-throws so Inngest can retry (1 retry configured); the `finally` always fires to emit the heartbeat.

**Result fields:** `state`, `alarmed`, `resolved`, `firstRedSha`, `reason` — passed to the heartbeat for observability.

## See also

- [[../control-tower/main-build-status]] — the sweep body that identifies the first-red commit, raises CEO-visible cards, and clears resolved outages.
- [[../specs/a-red-main-is-a-first-class-pipeline-alarm]] — the spec incident (2026-08-31 main could not build for ~40 minutes while the pipeline reported completely healthy).
- [[deploy-build-gate]] — Phase 2 extends the deploy build gate to the auto-merge chokepoint as a second line of defense.
