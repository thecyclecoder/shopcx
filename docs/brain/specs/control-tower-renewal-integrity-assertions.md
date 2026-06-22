# Control Tower — finish the renewal-integrity assertions (outcome distribution + stuck dunning) ⏳

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

## Phase 1 — outcome counts + the two assertions ⏳
Renewal cron emits the outcome breakdown; `monitor.ts` adds the outcome-distribution (spike-vs-baseline) + stuck-dunning assertions to `evalOutputAssertion`. Brain: [[../inngest/internal-subscription-renewals]] · [[../libraries/control-tower]] · [[../lifecycles/dunning]] · [[control-tower]].
