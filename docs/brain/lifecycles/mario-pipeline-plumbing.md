# Lifecycle: Mario — reactive pipeline plumbing (no spec silently stalls)

Every ShopCX spec moves through a fixed lifecycle — `created` → review → build phase(s) → ship → spec-test → security → fold — punctuated by unbounded waits. Before Mario, a spec could go silent for a reason nobody named (a wedged worker, an un-queued next phase, a missing status transition) and simply sit there. **Mario** closes that hole: every spec now carries a **timecard** that times each lifecycle step and the gap between steps; a once-per-minute deterministic detector flags a gap that exceeds its SLA and — unless the spec is legitimately waiting — enqueues a reactive box agent who investigates read-only, applies ONE non-destructive live fix to get the pipeline moving, auto-authors a critical fix-spec so the same stall can't recur, and self-tunes its own thresholds. The timer + step log is visible on the spec-detail page.

This is the end-to-end home for the **mario-pipeline-plumbing goal** (M1–M5, all shipped). Mario answers to **Ada** ([[../functions/platform]]) and is supervised by the CEO — the [[../operational-rules#north-star|north star]]: a bounded proxy (the detector's SLA) owned by a supervising role agent, never a silent proxy-optimizer.

Reactive-agent pattern **copied from [[../libraries/deploy-guardian|Reva]]** (deploy guardian): a cheap Inngest detector cron finds the outlier and INSERTs an [[../tables/agent_jobs]] row → the box worker dispatches by `kind` → a headless skill returns ONE typed JSON verdict (conservative default on ambiguity) → a single `applyBox…` mutator with an atomic claim-guard + a [[../tables/director_activity]] audit row is the ONLY writer.

## Why the stall-vs-wait split is the whole point

Mario's supervisability is its **determinism**. A *stall* is pipeline silence nobody named. A *legit wait* is a silence someone explicitly chose (an uncleared blocker, a `needs_input` question, an approval gate, a usage wall, a fold-cooldown). The detector never guesses — every drop below the stall line cites a concrete signal a human can inspect. The discriminator lives once in [[../libraries/mario]] so the detector cron, the box agent, and any future Mario-adjacent code share it.

| Legit wait (dropped, never a stall) | Where read |
|---|---|
| `blockedBy[i].cleared === false` — an upstream spec's code isn't on `main` yet | [[../libraries/brain-roadmap]] `getSpecBlockers` |
| live job `status` ∈ `{blocked_on_dependency, blocked_on_usage, needs_input, needs_approval}` | live [[../tables/agent_jobs]] row |
| `specs.status` ∈ `{folded, deferred}` — stopped emitting on purpose | [[../libraries/specs-table]] `getSpec` |

Every OTHER silence (last event was `build_done` and no `phase_shipped` in the SLA window; a `job_queued` no worker has claimed past the claim SLA; a `review_started` that never emitted a verdict) is a stall.

## End-to-end trace

1. **Emit (M1 + M2 — the timecard ledger).** Every lifecycle chokepoint appends ONE event to [[../tables/spec_timecard_events]] via [[../libraries/spec-timecards]] `recordTimecardEvent` (the single sanctioned writer, **best-effort — never throws**, so a ledger write can't block a Vale verdict, a build-worker status transition, Sol's Direction write, or a fold). Wait spans are tracked as `wait_entered` / `wait_exited` pairs carrying the `wait_kind` + `waiting_on` party. The ledger replaces reconstructing the timeline from [[../tables/spec_status_history]] + `agent_jobs.updated_at` + [[../tables/spec_test_runs]] + merge SHAs every time.
2. **Detect (M3 — the outlier cron).** [[../inngest/mario-stall-cron]] fires every minute (Vercel/Inngest runtime — no box token burn). It reads every [[../tables/mario_thresholds]] SLA row, per row calls [[../libraries/spec-timecards]] `listStalledCandidates(older_than_ms = row.sla_ms)`, keeps candidates whose `last_event_kind === from_event`, then applies the legit-wait discriminator above. Each survivor gets a bounded `MarioBrief` (last 10 timecard events + `blockedBy` state + current job status) attached.
3. **Enqueue (M3).** [[../libraries/mario]] `enqueueMarioJob` files ONE dedupe-guarded `kind='mario', status='queued'` [[../tables/agent_jobs]] row per candidate (SELECT-then-INSERT on `(workspace_id, kind, spec_slug, active-status)` → at most one live mario job per spec_slug). A per-tick cap of 25 keeps a backlog from overwhelming the mario lane.
4. **Investigate (M4 — the box agent).** The box worker's `runMarioJob` (`scripts/builder-worker.ts`, a `RERUNNABLE_KIND`) parses the brief → prompts `use the mario skill` → runs a headless `claude -p` on **Max** ([[../../.claude/skills/mario/SKILL.md]]). Mario investigates **read-only** (timecard + `getSpecBlockers` + live `agent_jobs` row), decides, and returns ONE typed `MarioVerdict` JSON envelope: `{ trigger_accurate, live_fix, durable_fix_spec, threshold_adjustment, escalate, reasoning }`. `normalizeMarioVerdict` fills conservative defaults; a same-session repair re-asks on a malformed verdict, then a FRESH-session third attempt re-runs the full prompt on a new session (via `runBoxLane`) if the repair still doesn't parse — the fresh session drops a poisoned first-session state (context+account) before the fail-safe stamps `needs_attention`. **On ambiguity, escalate — never guess a mutation.**
5. **Apply (M4 — the only mutator).** `applyBoxMario` ([[../libraries/mario]]) is the sole writer. Atomic claim-guard (first-claim-wins) + kill-switch `MARIO_AUTONOMY_MODE` (`live` / `surface_only` / `off`) + loop-guard `MARIO_LOOP_GUARD_MAX` (≥3 mario_fired rows for the same slug in 24h → escalate "oscillation risk" instead of firing a fourth fix). It executes ONE non-destructive live fix from the bounded vocabulary — `redrive_dropped_job` · `unstick_stale_status` · `release_cleared_blocker` · `requeue_unclaimed_job` · `queue_box_restart` (set `worker_controls.drain_for_update=true` so the box restarts at idle when Mario's own change touched box code). Broad autonomy per Dylan — execute any non-destructive fix; escalate ONLY clearly destructive/irreversible actions.
6. **Durably fix (M4).** When `durable_fix_spec` is present, Mario auto-authors a **critical `auto_build` fix-spec** via `authorSpecRowStructured` so the recurring stall class flows through the review/build/test gates autonomously — the same stall can't recur silently.
7. **Self-tune + audit (M4).** On `trigger_accurate=false`, `widenMarioThreshold` widens the matching [[../tables/mario_thresholds]] row (stamps `last_widened_at` + reason) so a false trigger tightens the SLA toward zero false positives; the fired→was-it-real signal is queryable so Ada can supervise. Every action writes one [[../tables/director_activity]] audit row — never silent.
8. **Surface (M5 — the spec-detail timeline).** The `[slug]/` detail route mounts `LifecycleTimeline` ([[../dashboard/roadmap]]), which reads `getTimecard(admin, workspace_id, slug)` + `readMarioThresholds` and paints per-stage `duration_ms`, inter-stage `gap_ms` pills colored by the matching SLA (zinc / amber / rose), a live `WaitTimer` island per open wait (naming the `waiting_on` party + running duration), and an "Elapsed / Total" badge. Mario's reasoning is visible where the CEO already looks.

## Code map

- Ledger: `src/lib/spec-timecards.ts` ([[../libraries/spec-timecards]]) → [[../tables/spec_timecard_events]]. Chokepoint callers: Vale's verdict, the box worker status transitions, Sol's `writeDirection`, the fold path, the spec-test verdict.
- Detector + decision: `src/lib/mario.ts` ([[../libraries/mario]]) — `evaluateStalledSpecs` / `enqueueMarioJob` (M3) + `normalizeMarioVerdict` / `applyBoxMario` / `widenMarioThreshold` (M4). Cron: `src/lib/inngest/mario-stall-cron.ts` ([[../inngest/mario-stall-cron]]).
- SLA rows: [[../tables/mario_thresholds]] (Mario self-tunes; the M4 agent is the sole writer of updates).
- Box agent: `scripts/builder-worker.ts` `runMarioJob` + [[../../.claude/skills/mario/SKILL.md]] (read-only investigation + the five-key vocabulary + the `MarioVerdict` envelope).
- UI: `src/app/dashboard/roadmap/{LifecycleTimeline,WaitTimer}.tsx` + `[slug]/page.tsx` ([[../dashboard/roadmap]]).
- Org placement: [[../../src/lib/agents/personas.ts]] `PERSONAS['mario']` + [[../../src/lib/control-tower/registry.ts]] `MONITORED_LOOPS` (worker under Ada / `owner:'platform'`).

## Status / open work

**Shipped + folded (2026-07-09, mario-pipeline-plumbing goal — all 5 milestones landed):**
- **M1 — timecard ledger + SDK** ✅ — [[../tables/spec_timecard_events]] (append-only) + [[../libraries/spec-timecards]] (`recordTimecardEvent` writer · `getTimecard` / `foldTimeline` / `listStalledCandidates` readers). Migration `20261001120000_spec_timecard_events.sql`.
- **M2 — chokepoint instrumentation + wait tracking** ✅ — one event at each Vale / build-start-done / phase-ship / spec-test / security / fold chokepoint, plus `wait_entered` / `wait_exited` spans naming the waiting party.
- **M3 — outlier detector cron + self-owned thresholds** ✅ — [[../tables/mario_thresholds]] + [[../libraries/mario]] `evaluateStalledSpecs` / `enqueueMarioJob` + [[../inngest/mario-stall-cron]] (every minute).
- **M4 — Mario box agent** ✅ — `runMarioJob` + [[../../.claude/skills/mario/SKILL.md]] + `applyBoxMario` (kill-switch + loop-guard + non-destructive vocabulary + `auto_build` fix-spec author + threshold self-tune + `director_activity` audit). Persona/avatar/org-placement registered under Ada.
- **M5 — spec-detail timecard timeline** ✅ — `LifecycleTimeline` + `WaitTimer` on the spec-detail sidebar.

**Success metric (goal charter):** median stall detected in < 1 SLA window; > 90% of Mario triggers self-graded trigger-accurate; every recurring stall closed by a merged critical fix-spec; zero false triggers on legitimately-blocked or waiting specs. Trigger-accuracy + false-trigger rate are queryable off [[../tables/director_activity]] for Ada's supervision; a false trigger widens its own SLA row toward zero false positives.

## Related

[[../functions/platform]] (Mario's org home — reports to Ada) · [[../libraries/mario]] · [[../libraries/spec-timecards]] · [[../libraries/deploy-guardian]] (the Reva template Mario copies) · [[../inngest/mario-stall-cron]] · [[../tables/spec_timecard_events]] · [[../tables/mario_thresholds]] · [[../dashboard/roadmap]] · [[roadmap-build-console]] (the spec pipeline Mario plumbs) · [[../operational-rules]] § north star
