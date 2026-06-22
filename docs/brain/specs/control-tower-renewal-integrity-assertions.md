# Control Tower — finish the renewal-integrity assertions (outcome distribution + stuck dunning) 🚧

**Owner:** [[../functions/retention]] · **Parent:** completes [[control-tower]] P2 renewal-integrity (the highest-value assertion, only partly built).

[[control-tower]] P2 declared three renewal-integrity assertions; a live audit (human-queue workflow, 2026-06-22) found **only one is implemented** (`due-but-not-renewed` overdue check). The other two are **not built**:
- **Outcome distribution** — the renewal cron (`src/lib/inngest/internal-subscription-renewals.ts:67`) emits only `produced:{dispatched: due.length}` — **no per-cycle outcome counts**, so a systemic break (e.g. bad Braintree creds declining everyone, a spike in `no_payment_method` skips) is invisible. There's no decline-rate / spike-vs-baseline logic anywhere in `src/lib/control-tower/`.
- **Stuck dunning** — no assertion for a sub stuck in dunning past its retry schedule (live: 0 of 404 `retrying` dunning_cycles are past `next_retry_at` today, but nothing would surface it if they were).

A silently-broken renewal = lost revenue + quiet churn — the exact failure the Control Tower exists to catch, currently half-blind.

## Fix
- **Renewal cron emits per-cycle outcome counts.** `internal-subscription-renewal-cron` produces `{charged, skipped_no_payment_method, skipped_zero_total, declined_to_dunning, comp_shipped, error}` (not just `dispatched`) in its `loop_heartbeats.produced`.
- **Outcome-distribution assertion** (`evalOutputAssertion` in `monitor.ts`): a **spike** in skips/declines/errors vs a rolling baseline → alert ("renewal decline rate {x}% / {n} no-PM skips"). Catches a systemic break even when each decline individually "routed to dunning correctly."
- **Stuck-dunning assertion:** a `dunning_cycles` row `status='retrying'` past `next_retry_at` by a grace, with no resolution → surface ("N subs stuck in dunning past retry"). A sub *correctly* mid-dunning (within schedule) is NOT flagged.

## Verification
- After a renewal cycle, the `internal-subscription-renewal-cron` `loop_heartbeats.produced` carries the full outcome breakdown (not just `dispatched`); the Control Tower tile shows it.
- Force a decline spike (e.g. a test cycle where most subs skip `no_payment_method`) → outcome-distribution alert fires; a normal cycle → green with the breakdown.
- Leave a `dunning_cycles` row `retrying` past `next_retry_at` + grace → stuck-dunning alert; a sub within its retry schedule → not flagged.

## Phase 1 — outcome counts + the two assertions ✅ (code shipped — prod verification pending)
Renewal cron emits the outcome breakdown; `monitor.ts` adds the outcome-distribution (spike-vs-baseline) + stuck-dunning assertions to `evalOutputAssertion`. Brain: [[../inngest/internal-subscription-renewals]] · [[../libraries/control-tower]] · [[../lifecycles/dunning]] · [[control-tower]].

### What shipped
- **Per-sub outcome beats.** `internal-subscription-renewal-attempt` emits ONE `emitRenewalOutcomeHeartbeat(outcome)` on every terminal path (`charged` · `declined_to_dunning` · `skipped_no_payment_method` · `skipped_zero_total` · `comp_shipped` · `comp_blocked` · `skipped_other`) under `loop_id = RENEWAL_OUTCOME_LOOP_ID` (`src/lib/control-tower/registry.ts`, `heartbeat.ts`). The only uniform channel that captures skips (no transaction row). Uncaught errors are NOT beat — they're caught by the existing renewal-integrity overdue assertion (a sub that errored never advances).
- **Cron heartbeat carries the breakdown.** `internal-subscription-renewal-cron`'s `produced = { dispatched, last_cycle_outcomes, last_cycle_since }` — `aggregateRenewalOutcomes` over the beats since the previous cron beat (the most-recently-completed cycle; fan-out is async so the just-dispatched cycle isn't knowable at beat time). The tile renders it.
- **outcome-distribution assertion** (`monitor.ts` → `evalOutputAssertion` case `renewal-outcome-distribution`, on `internal-subscription-renewal-cron` via `outputAssertions: ["renewal-integrity", "renewal-outcome-distribution"]`): fires on a systemic anomalous rate ≥50% (hard floor — bad creds declining everyone / mass no-PM) OR a spike ≥2.5× / +15pp vs the rolling 30-day baseline, gated by ≥10-sample cycle + ≥50-sample baseline. The monitor aggregates the LIVE current cycle (since the latest cron beat) every ~15m.
- **stuck-dunning assertion** (`evalOutputAssertion` case `stuck-dunning`, on `dunning-payday-retry-cron` via `outputAssertion: "stuck-dunning"`): fires when N `dunning_cycles` are `status='retrying'` with `next_retry_at` >48h in the past. Within-schedule cycles (future/recent `next_retry_at`, or null) are not flagged.
- Thresholds are tunable constants in `monitor.ts`.

**Note on the cron `produced` breakdown:** because the renewal fan-out is async (per-sub attempts run after the cron's beat is written), the cron beat carries the *most-recently-completed* cycle's breakdown, not the cycle it just dispatched. Same-cycle timeliness comes from the monitor's live aggregation (every ~15m). The verification's "after a renewal cycle, the cron `produced` carries the breakdown" holds with this one-cycle lag; the **tile** shows the live current-cycle anomaly the moment the assertion trips.
