# inngest/subscriber-experiment-guardrails

Daily guardrail + verdict cron for the pre-renewal reminder 50/50 test — the retention autonomy
layer left unbuilt by `subscriber-experiment-guardrails-verdict` Phases 2–3.

**File:** `src/lib/inngest/subscriber-experiment-guardrails.ts` (thin wrapper) · logic in
[[../libraries/subscriber-experiment-guardrails]].

## Function

| id | trigger | owner |
|---|---|---|
| `subscriber-experiment-guardrail-cron` | `cron: 0 14 * * *` (daily, after the 13:00 reminder cron) | `retention` |

Registered in `src/lib/inngest/registered-functions.ts` and as a `retention`-owned `MONITORED_LOOPS`
row in `src/lib/control-tower/registry.ts` (`expectedCadence: "daily (0 14 * * *)"`,
`livenessWindowMs: 30h` per the monitor-cadence invariant). Its kill-switch ancestry is the
retention function (resolved through the node registry); `runSubscriberExperimentGuardrails` honours
an effective OFF (no evaluation, still heartbeats). Emits `emitCronHeartbeat` on EVERY tick (incl.
the kill-switch-off / no-running-experiment path) — node-completeness hard rule.

## What it does each tick

For every workspace with a **running** pre-renewal experiment:

1. **Guardrails** (treatment vs holdout) via [[../libraries/subscriber-experiment-guardrails]]
   `evaluateGuardrails`: voluntary cancel rate, refund rate, SMS STOP opt-out rate, and net
   merchandise revenue per person. A signal trips on EITHER a **sequential-safe anytime-valid**
   confidence-sequence test (`proportionHarmTripped` — valid at every sample size, so daily peeking
   can't inflate false trips) OR a **hard floor**: STOP > 5% (ABSOLUTE — holdout sends no SMS), and —
   **holdout-relative** since launch follow-up Phase 2 — treatment cancel/refund EXCESS over holdout
   > 5 points (`voluntaryCancelExcessOverHoldout` / `refundExcessOverHoldout`, past ≥50/arm), plus
   net-revenue > 20% below holdout with ≥50/arm. (The old absolute cancel/refund > 20% floors tripped
   on baseline churn the reminder never caused.)
2. **On a trip** → `setExperimentStatus(..., 'stopped', { by: 'guardrail', reason })` (which, after
   Phase 4, halts ALL reminders) + ONE deduped CEO [[../tables/dashboard_notifications]] row
   (dedupe key `subscriber-experiment:<id>:guardrail_trip`). Never auto-resumes.
3. **Verdict** → when the pre-registered `required_n_per_arm` is reached AND every assignment's
   90-day window has closed, `evaluateVerdict` runs a two-sample **Welch's t-test** at the
   experiment's pre-registered `alpha` on per-person net merchandise revenue — a winner
   (`treatment_wins`/`holdout_wins`) is declared ONLY when the `confidenceInterval` on the lift
   excludes 0, else `no_difference`. `recordExperimentVerdict` (status → `complete` + verdict fields,
   detail carries the interval) + ONE deduped CEO notification (`...:verdict`).

North star: the cron only ever PAUSES or CONCLUDES; launching/resuming stays a CEO-approved status
flip. It escalates (notify) rather than silently executing.

## See also

- [[../libraries/subscriber-experiment-guardrails]] · [[../libraries/subscriber-experiments]] · [[../libraries/subscriber-experiment-metrics]] · [[../libraries/reminder-results-sdk]] · [[../lifecycles/pre-renewal-reminder-journey]] · [[subscriber-experiment-guardrails]]
