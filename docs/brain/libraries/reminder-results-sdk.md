# `src/lib/retention/reminder-results-sdk.ts` — pre-renewal-reminder results lens

The read-only RESULTS surface for the pre-renewal-reminder 50/50 test — the one lens the M4 retention dashboard (and any CLI) reads so no caller hand-rolls the joins or re-derives revenue. Spec: `renewal-reminder-results-dashboard` **Phase 1**. Part of the [[../lifecycles/pre-renewal-reminder-journey]] flow (M4 "Results dashboard"). Mirrors the compose-several-reads, return-a-typed-shape pattern of the Ad Testing results SDK ([[testing-results-sdk]]).

## `getReminderTestResults(admin, workspaceId) → ReminderTestResults`

Composes four read surfaces into one treatment-vs-holdout shape. **Strictly read-only** — mutates nothing.

1. **Metrics** — [[subscriber-experiment-metrics]] `computeExperimentMetrics` for each arm's 90-day net revenue per customer + the secondary rates. REUSED, never re-derived: `charges − settled refunds` is defined in exactly one place. Phase 1 of this build extended `ArmMetrics` with `grossRevenueCents` / `refundsCents` / `refundedCustomerGroups` so the refund rate reuses that same per-group expansion pass.
2. **Send ledger** — [[pre-renewal-reminders]] `listReminderLedger` (the ledger's read chokepoint; all `.from("pre_renewal_reminders")` stays in that module). Rolls up per-arm `reminded` / `emailsSent` / `smsSent` / `smsSuppressedStop` / `smsSuppressedNoConsent` / `smsOptOutsAfterReminder`. The last is the real opt-out signal: a customer TEXTED a reminder (`sms_status` 'scheduled'|'sent') whose `customers.sms_marketing_status` later flipped to `unsubscribed` after `sms_scheduled_send_at` — resolved by `fetchSmsOptOuts` (reads `customers.sms_marketing_status` + `updated_at` for the texted customers, since there is no dedicated consent-event ledger). `smsSuppressedStop` is the ALREADY-unsubscribed-at-send-time count (informational only; never an opt-out the test caused).
3. **Journey events** — [[../tables/journey_step_events]] `step_key='lifecycle'`, attributed to an arm via the ledger's `journey_session_id → experiment_arm`. Folds `opened` / `edited` / `swapped` (the swap/add-on subset of `edited`) / `skipped` / `cancelled` / `saved`. Because the holdout gets no reminder and no journey, its engagement is zero by design — the clean counterfactual.
4. **Harness row** — [[subscriber-experiments]] `getExperiment` for the experiment lifecycle status + pre-registered `required_n_per_arm`, read ONLY through the SDK (never a raw `.from` on the experiment tables, CLAUDE.md raw-`.from` STOP rule).

Returns `{ generatedAt, experimentSlug, windowDays, arms: { treatment, holdout }, guardrails, verdict }`. Zeroed arms + an `absent` verdict when the experiment doesn't exist for the workspace.

## Per-arm shape (`ArmResults`)

`customerGroups`, the `engagement` funnel (above), `netRevenueCents` / `netRevenuePerCustomerCents` (primary), `grossRevenueCents` / `refundsCents`, `refundRate` (= `refundedCustomerGroups / customerGroups`), and `voluntaryCancelRate`.

## Guardrails + verdict — DERIVED in Phase 1

The dedicated guardrail evaluator + verdict engine (`subscriber-experiment-guardrails-verdict` Phases 2–3) are not on main yet, so Phase 1 derives a live read from what the harness + metrics already expose — flagged `derived: true` on the verdict:

- **`deriveGuardrails`** — `sampleComplete` (both arms ≥ `required_n_per_arm`), `smsOptOutsAfterReminder` (post-reminder STOP replies across arms — the dashboard's "STOP replies to reminder texts") + `smsAlreadyUnsubscribed` (already-unsubscribed-before-run, informational), and a coarse `status: 'ok' | 'watch'` that trips to `watch` with a note when treatment's refund or voluntary-cancel rate exceeds holdout's.
- **`deriveVerdict`** — `experimentStatus`, `concluded` (status `stopped`/`complete`), `leadingArm` (higher net revenue per customer), and `netRevenuePerCustomerLiftCents` (treatment − holdout). Superseded by the real verdict engine once it lands.

## Pure core (unit-tested)

`rollupEngagement`, `buildArmResults`, `deriveGuardrails`, `deriveVerdict` are pure (no I/O) and pinned in `src/lib/retention/reminder-results-sdk.test.ts` (`npm run test:reminder-results-sdk`), the same way the testing-results SDK unit-tests its rollup math. `getReminderTestResults` is the only DB-touching function.

## Consumers

- `GET /api/workspaces/[id]/analytics/renewal-reminder` → the retention results page (Phase 2 + 3 of this spec — not yet built).

## Related

[[subscriber-experiment-metrics]] · [[subscriber-experiments]] · [[pre-renewal-reminders]] · [[testing-results-sdk]] · [[../tables/pre_renewal_reminders]] · [[../tables/journey_step_events]] · [[../tables/order_refunds]] · [[../lifecycles/pre-renewal-reminder-journey]] · [[../functions/retention]]
