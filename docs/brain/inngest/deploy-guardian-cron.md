# inngest/deploy-guardian-cron

Reva's evaluate + act tick ([[../specs/deploy-health-rollback-guardian]]). Every minute it evaluates each auto-merged deploy's canary watch once its window has elapsed, stamps the verdict, and **acts on it** (Phase 2: auto-rollback + CEO escalation on `regressed`). Runs in the Vercel/Inngest runtime (where the error feed lives), NOT the box — no token burn, reuses Tao's Control-Tower signals.

**File:** `src/lib/inngest/deploy-guardian-cron.ts` · logic in [[../libraries/deploy-guardian]]

## Functions

### `deploy-guardian-cron`
- **Trigger:** cron `* * * * *` (every minute)
- **Config:** `retries: 1` (the next tick re-evaluates in a minute — no value in long retries here)
- **What it does:** calls `evaluateDueDeployWatches()` ([[../libraries/deploy-guardian]]) — finds every `pending` [[../tables/deploy_watches]] row whose `window_ends_at` has passed (bounded 25/tick) and evaluates each: samples NEW [[../tables/error_events]] signatures + NEW open [[../tables/loop_alerts]] + the live [[../libraries/control-tower]] snapshot, attributing only signals that FIRST appear AFTER the deploy timestamp (the correlation gate), then routes on the findings verdict ([[../specs/reva-box-session-causal-rollback]] Phase 1 — the **cron stops deciding**): `healthy` → claim + stamp `verdict='healthy'` + `deploy_healthy` [[../tables/director_activity]] row (unchanged fast path); ATOMIC `is_atomic` + non-healthy (a `goal/<slug>` Gate-C promotion carrying many specs) → claim + stamp `regressed`/`unsure` + **escalate, never auto-revert** (reverting a whole tested goal is far costlier than a per-phase revert — never routed through a per-signal review); per-spec + non-healthy (a `claude/<slug>` Gate-A merge) with loop-guard `DEPLOY_GUARDIAN_LOOP_GUARD_MAX` NOT tripped → claim + stamp `verdict='in_review'` + enqueue ONE `kind='deploy-review'` [[../tables/agent_jobs]] row (Reva's Max session reads the merge_sha's diff, judges per-signal causal plausibility, and returns `revert｜keep｜escalate` — Phase 3's `applyBoxDeployReview` applies the typed verdict); per-spec + non-healthy + loop-guard TRIPPED → claim + stamp `regressed` + escalate + **halt, do NOT enqueue** (a rollback-then-reland loop is a deeper issue, not a per-signal review candidate).
- **Self-monitoring:** emits a `deploy-guardian-cron` heartbeat at the end (`emitCronHeartbeat`). `ok` = the tick completed; a `regressed`/`unsure` verdict is a real product signal, not a cron failure. Registered in `src/lib/control-tower/registry.ts` (`MONITORED_LOOPS`) so a dead evaluator shows as a stale cron tile.
- **Returns** `{ due, evaluated: [{ id, slug, verdict }] }`.

## Downstream events sent

_None._ Side effects are the [[../tables/deploy_watches]] verdict stamp + the [[../tables/director_activity]] row (on `healthy` / loop-guarded regressed / atomic paths) + a new `kind='deploy-review'` [[../tables/agent_jobs]] row on a per-spec non-healthy verdict under the loop-guard ([[../specs/reva-box-session-causal-rollback]] Phase 1 — the box worker later runs Reva's Max session against the watch, then applies the typed verdict via Phase 3's `applyBoxDeployReview`, which is the mutator that actually calls `revertDeployMerge` + `escalateDiagnosisToCeo`). A `regressed` **atomic** (`is_atomic`) watch skips the revert and escalates only. A loop-guarded slug escalates + fires a critical [[../integrations/slack]] ops alert + halts (no session enqueue, no revert).

## Tables written

- [[../tables/deploy_watches]] (the verdict stamp — `healthy` / `regressed` / `unsure` / `in_review` — + `findings.rollback` outcome once Phase 3's `applyBoxDeployReview` acts)
- [[../tables/agent_jobs]] (one `kind='deploy-review'` row on a per-spec non-healthy verdict under the loop-guard — [[../specs/reva-box-session-causal-rollback]] Phase 1)
- [[../tables/director_activity]] (one `deploy_healthy`/`deploy_regressed`/`deploy_unsure`/`deploy_atomic_regressed`/`deploy_rolled_back` row per acted watch — the cron writes on `healthy` + loop-guarded + atomic paths; Phase 3's worker writes on `deploy_rolled_back` / `deploy_kept`)
- [[../tables/dashboard_notifications]] (the CEO escalation, via `escalateDiagnosisToCeo` — on atomic + loop-guarded + Phase-3 revert/escalate paths)
- [[../tables/loop_heartbeats]] (its own end-of-run beat)

## Related

[[../libraries/deploy-guardian]] · [[../tables/deploy_watches]] · [[../libraries/github-pr-resolve]] · [[../libraries/platform-director]] · [[../specs/deploy-health-rollback-guardian]] · [[../specs/agent-outage-resilience]]
