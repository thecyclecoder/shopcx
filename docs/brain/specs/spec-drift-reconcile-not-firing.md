# spec-drift-reconcile cron registered but never fires (+ catch the registered-not-firing class) ⏳

**Owner:** [[../functions/platform]] · **Parent:** restores [[spec-drift-agent]]'s backstop; extends [[control-tower]] + [[control-tower-complete-coverage]]. · **Found in use 2026-06-22:** the roadmap had stale cards (`ticket-csat-cron-heartbeat-on-idle` #219, `portal-auto-resume-heartbeat-on-empty` #218 — builds merged, phases never flipped). Root cause: **`spec-drift-reconcile` — the every-30-min drift backstop — has NEVER emitted a heartbeat** (`loop_heartbeats` has 0 beats for it), so residual drift is never auto-reconciled.

Crucially this is **not** a code bug and **not** a registration gap:
- The reconciler **logic works** — a manual `runSpecDriftReconciler(ws)` completed cleanly (scanned 13 specs, surfaced 2; no throw).
- It **is registered** with Inngest (`GET /v1/apps/shopcx/functions` lists `spec-drift-reconcile`; the `diffInngestRegistered` self-audit says `missing:[]`).
- Its registry `id` ("spec-drift-reconcile") matches its `emitCronHeartbeat("spec-drift-reconcile", …)` — no loop_id mismatch.

So a **registered cron with a valid schedule (`20,50 * * * *`) is simply not executing** — and nothing caught it, because the Control Tower's coverage checks for *served-but-not-registered* (the registration diff), not *registered-but-never-firing*.

## Investigate → fix
- **Why doesn't it execute?** Check the Inngest function's run history (has `spec-drift-reconcile` ever run, or 0 runs?), whether its **cron trigger** is actually active in the **prod** Inngest env (vs registered without the schedule, or under a different env/app version), and whether a proper **app re-sync** (`PUT /api/inngest` / dashboard "sync new app version") activates the schedule — the same resync that previously surfaced new functions for the control-tower-monitor. Fix the root cause so it fires every ~30 min and beats.
- **Catch the class (the real prevention):** the Control Tower should flag a **registered cron-triggered function that has emitted ZERO heartbeats for longer than its window** as "registered but not firing" — a distinct signal from never-registered. This is the gap that let a dead backstop hide. (A monitored cron in `registry.ts` that has never beat past its `livenessWindowMs` ⇒ alert, even if it's in the Inngest registered set.)

## Verification
- `spec-drift-reconcile` emits a `loop_heartbeats` beat every ~30 min (its tile on the Control Tower goes green "ran Ns ago" with `produced.{specsScanned,flipped,surfaced}`), confirming it executes on schedule.
- Create a fresh single-phase drift (a spec whose build merged + code on main but the phase left ⏳) → within one ~30-min cycle it auto-flips to ✅ with **no manual run** — the backstop self-heals drift.
- The "registered-but-never-firing" guard: a monitored cron with 0 beats past its window surfaces a Control Tower alert (harness or a deliberately-paused cron), distinct from the registration-diff signal.
- Negative: a healthy firing cron (e.g. `portal-action-healer`) is not flagged.

## Phase 1 — get the cron firing + add the registered-not-firing guard ⏳
Diagnose + fix `spec-drift-reconcile`'s non-execution (re-sync / cron-trigger registration in the prod Inngest env); add the zero-beats-past-window detection to the monitor for registered cron loops. Brain: [[spec-drift-agent]] · [[../inngest/spec-drift-reconcile]] · [[../libraries/control-tower]] · [[../integrations/inngest]] · [[control-tower]].
