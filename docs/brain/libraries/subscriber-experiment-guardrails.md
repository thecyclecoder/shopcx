# libraries/subscriber-experiment-guardrails

The guardrail + verdict ENGINE for the pre-renewal reminder 50/50 test — the logic the daily
[[../inngest/subscriber-experiment-guardrails]] cron (`subscriber-experiment-guardrail-cron`) runs.

**File:** `src/lib/subscriber-experiment-guardrails.ts`

## Why it exists

The CEO requirement (2026-11-17): the test is self-running and the CEO hears about it only on a
critical guardrail trip or the final verdict. This module auto-pauses the test on harm and records
the verdict at window-close — the autonomy layer the M4 dashboard's derived labels only approximated.

## Exports

### `GUARDRAIL_CRON_LOOP_ID` — `"subscriber-experiment-guardrail-cron"`

The control-tower loop id (owner: retention). Used for the kill-switch resolve + heartbeat.

### `anytimeValidRadius(n, variance, alpha)` — pure

An iterated-logarithm (Howard-style sub-Gaussian) confidence radius that is valid at EVERY sample
size — the sequential-safe core, so daily peeking does not inflate the false-trip rate (unlike a
fixed-n z-interval re-read each day).

### `proportionHarmTripped(pT, nT, pH, nH, alpha)` — pure

Is treatment's bad-rate anytime-valid-significantly WORSE than holdout's (disjoint anytime-valid
intervals in the harmful direction)? Variance proxy floored for conservatism.

### `evaluateGuardrails(treatment, holdout, alpha?)` — pure → `GuardrailEvaluation`

Every guardrail (voluntary cancel, refund, SMS STOP opt-out, net merchandise revenue) trips on EITHER
the anytime-valid test OR a hard floor (`HARD_FLOORS`). Takes two `ArmResults`
([[reminder-results-sdk]]).

- **Cancel + refund floors are HOLDOUT-RELATIVE** (launch follow-up Phase 2): they trip on treatment's
  EXCESS over holdout (`voluntaryCancelExcessOverHoldout` / `refundExcessOverHoldout`, 0.05 = 5 points),
  not the treatment arm's absolute rate. Normal 90-day churn hits both arms equally, so an absolute
  floor on treatment alone would pause the test on baseline churn the reminder never caused. Gated on
  both arms clearing `netRevenueMinN` (50).
- **The SMS STOP opt-out floor stays ABSOLUTE** (`smsOptOutRate` 0.05) — the holdout sends no SMS, so
  there is no holdout baseline to net against.
- **The SMS opt-out rate counts POST-reminder STOPs only** (first-run fix, 2026-11-24). The rate is
  `treatment.engagement.smsOptOutsAfterReminder / treatment.engagement.smsSent` — customers who were
  actually TEXTED a reminder (`sms_status` 'scheduled'|'sent') and THEN opted out of SMS marketing
  (their `customers.sms_marketing_status` flipped to `unsubscribed` after `sms_scheduled_send_at`),
  over customers actually texted. It no longer uses `smsSuppressedStop` (customers ALREADY
  unsubscribed at send time), which never got a reminder and so can't be an opt-out the test caused —
  counting it false-tripped the guardrail on the first live run (15 already-unsubscribed + 34 texted
  with 0 real STOPs read as ~31% and paused the test). Already-unsubscribed rows are excluded from
  BOTH numerator and denominator (they are `suppressed_stop`, never sent/scheduled). The
  post-reminder count is computed in [[reminder-results-sdk]] `rollupEngagement` /
  `fetchSmsOptOuts` and surfaced on the dashboard as **"STOP replies to reminder texts"**, with
  **"already unsubscribed before run"** (`smsAlreadyUnsubscribed`) shown separately as informational.
- **Net-revenue is judged ONLY on MATURED windows** (2026-11-28 false-trip fix). It compares each
  arm's `maturedNetRevenuePerCustomerCents` — the mean over groups whose reminded renewal has billed +
  settled (`isRevenueWindowMatured`) — never the partial-window all-groups mean. It trips on a material
  relative drop (`netRevenueRelativeDrop`) ONLY once BOTH arms have ≥`netRevenueMinN` (50) MATURED
  groups; below that the signal emits `tripped=false` with reason `insufficient matured data (T x / H y)`
  and cannot trip. The live incident: four days in, 128 treatment / 109 holdout groups with zero matured
  renewals, treatment $0.00 vs holdout $0.55/person — the all-groups material-drop floor would have
  paused the test on noise; the matured gate reads it as insufficient data instead. `maturedGroups` +
  `maturedNetRevenuePerCustomerCents` are exposed per arm by [[reminder-results-sdk]]
  (`computeMaturedArmRevenue`, folding [[subscriber-experiment-metrics]] `perGroupNet` against the
  reminded renewal date from the [[../tables/pre_renewal_reminders]] ledger).

### `isRevenueWindowMatured(group, now)` — pure · `REVENUE_WINDOW_SETTLE_DAYS` = 7

Has a person-group's revenue measurement window MATURED — i.e. has its reminded renewal both billed
AND had a settle buffer to clear refunds/retries? True only once `now >= group.remindedRenewalAt +
REVENUE_WINDOW_SETTLE_DAYS`. `remindedRenewalAt` is the `next_billing_date` captured on the
[[../tables/pre_renewal_reminders]] ledger (holdout rows carry it too). A group with no/unparseable
renewal date is NEVER matured, so a partial-window $0 can't enter the net-revenue comparison. This is
the gate the net_revenue signal above counts groups against.

### `evaluateVerdict(treatment, holdout, alpha?)` — pure → `VerdictResult`

Classifies the terminal verdict on the primary metric (90-day net merchandise revenue per person):
`treatment_wins` | `holdout_wins` | `no_difference`. A winner is declared ONLY when a two-sample
**Welch's t-test** on per-person net merchandise revenue REJECTS at the experiment's pre-registered
`alpha` — i.e. the `confidenceInterval` { lowCents, highCents } on the lift excludes 0 (launch
follow-up Phase 2). The old 1%-relative-lift rule named a winner on noise the test (powered for ~10%
MDE) can't tell from zero; it's gone. The verdict `detail` reports the lift, the `confidenceInterval`,
`alpha`, `significant`, and the Welch-Satterthwaite `degreesOfFreedom`. The Welch helper
(`welchTwoSampleCI` + `studentTQuantile`) lives in [[subscriber-experiment-metrics]] and reads each
arm's `netRevenueVarianceCents2` (sample variance of per-person net revenue, added there).

### `evaluateWorkspaceGuardrails(workspaceId, now, admin)` / `runSubscriberExperimentGuardrails(now?, admin?)`

The per-workspace + fan-out run. Reads results through [[reminder-results-sdk]]
`getReminderTestResults`; on a trip calls [[subscriber-experiments]] `setExperimentStatus(...'stopped')`,
on conclusion `recordExperimentVerdict`, each followed by ONE deduped CEO notification. Honours the
cron kill switch. Only ever PAUSES or CONCLUDES — never launches/resumes (north star).

## Guardrails / notes

- The only writes are through the status SDK (pause/verdict) + a deduped CEO notification
  ([[../tables/dashboard_notifications]], `type:'system'`, dedupe on `metadata.dedupe_key`).
- Email unsubscribe/complaint rate is a documented future guardrail input (the spec's "from
  email_events if available") — not yet wired; the four shipped guardrails are above.

## See also

- [[../inngest/subscriber-experiment-guardrails]] · [[subscriber-experiments]] · [[subscriber-experiment-metrics]] · [[reminder-results-sdk]] · [[../lifecycles/pre-renewal-reminder-journey]]
