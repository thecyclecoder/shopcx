# inngest/deploy-guardian-cron

Reva's evaluate + act tick ([[../specs/deploy-health-rollback-guardian]]). Every minute it evaluates each auto-merged deploy's canary watch once its window has elapsed, stamps the verdict, and **acts on it** (Phase 2: auto-rollback + CEO escalation on `regressed`). Runs in the Vercel/Inngest runtime (where the error feed lives), NOT the box — no token burn, reuses Tao's Control-Tower signals.

**File:** `src/lib/inngest/deploy-guardian-cron.ts` · logic in [[../libraries/deploy-guardian]]

## Functions

### `deploy-guardian-cron`
- **Trigger:** cron `* * * * *` (every minute)
- **Config:** `retries: 1` (the next tick re-evaluates in a minute — no value in long retries here)
- **What it does:** calls `evaluateDueDeployWatches()` ([[../libraries/deploy-guardian]]) — finds every `pending` [[../tables/deploy_watches]] row whose `window_ends_at` has passed (bounded 25/tick) and evaluates each: samples NEW [[../tables/error_events]] signatures + NEW open [[../tables/loop_alerts]] + the live [[../libraries/control-tower]] snapshot, attributing only signals that FIRST appear AFTER the deploy timestamp (the correlation gate), then stamps `healthy`｜`regressed`｜`unsure` on the watch (claiming it atomically) and **acts**: `regressed` → auto-revert to known-good (`revertDeployMerge`) + CEO escalation; `unsure` → escalate, never auto-act; loop-guard on a rollback-then-reland loop.
- **Self-monitoring:** emits a `deploy-guardian-cron` heartbeat at the end (`emitCronHeartbeat`). `ok` = the tick completed; a `regressed`/`unsure` verdict is a real product signal, not a cron failure. Registered in `src/lib/control-tower/registry.ts` (`MONITORED_LOOPS`) so a dead evaluator shows as a stale cron tile.
- **Returns** `{ due, evaluated: [{ id, slug, verdict }] }`.

## Downstream events sent

_None._ Side effects are the [[../tables/deploy_watches]] verdict stamp + the [[../tables/director_activity]] row + (Phase 2 on `regressed`) a `git revert` commit on `main` via the GitHub git-data API + a CEO-routed Approval Request ([[../libraries/platform-director]] `escalateDiagnosisToCeo`) + a critical [[../integrations/slack]] ops alert on loop-guard/failed-revert.

## Tables written

- [[../tables/deploy_watches]] (the verdict stamp + `findings.rollback` outcome)
- [[../tables/director_activity]] (one `deploy_healthy`/`deploy_regressed`/`deploy_unsure`/`deploy_rolled_back` row per evaluated watch)
- [[../tables/dashboard_notifications]] (Phase 2 — the CEO escalation, via `escalateDiagnosisToCeo`)
- [[../tables/loop_heartbeats]] (its own end-of-run beat)

## Related

[[../libraries/deploy-guardian]] · [[../tables/deploy_watches]] · [[../libraries/github-pr-resolve]] · [[../libraries/platform-director]] · [[../specs/deploy-health-rollback-guardian]] · [[../specs/agent-outage-resilience]]
