# Retention → Renewal Reminder (`/dashboard/retention/renewal-reminder`)

Owner-only, **read-only** page: the live view of the pre-renewal-reminder 50/50 test — treatment vs holdout side by side, the engagement funnel, the primary 90-day net-revenue-per-customer comparison + refund rate, the live guardrail strip, and the verdict banner once the test concludes. Mobile-first (cards, not tables) per [[../ui-conventions]], with the [[ad-testing|Ad Testing]] page as the pilot reference.

## What it shows

- **Two arm cards** (treatment · holdout): assigned person-groups, the reminder/journey funnel (sent · opened · edited · swapped · skipped · cancelled · saved), 90-day net revenue per customer, and refund rate. Holdout engagement is zero by design — the clean counterfactual.
- A **primary-metric strip**: treatment vs holdout net revenue per customer and the lift between them.
- A **guardrail strip**: sample progress vs the pre-registered `required_n_per_arm`, SMS STOP opt-outs, and an ok/watch status with notes.
- A **verdict banner** when the experiment status is terminal (stopped/complete) — which arm leads on the primary metric. Phase-1 derived (flagged), superseded by the dedicated verdict engine once it lands.

## Data path

`GET /api/workspaces/[id]/analytics/renewal-reminder` → [[../libraries/reminder-results-sdk]] `getReminderTestResults` (composes the harness experiment row + metrics, the M2 reminder send ledger, and the M1 next-order journey events). Auth: Supabase session; **owner-gated** in the route (`workspace_members.role === 'owner'`) and in the sidebar (`ownerOnly`). READ-ONLY — never mutates the experiment, ledger, or journey rows.

## Related

[[../libraries/reminder-results-sdk]] · [[../libraries/subscriber-experiment-metrics]] · [[../libraries/pre-renewal-reminders]] · [[ad-testing|Analytics → Ad Testing]] · [[../lifecycles/pre-renewal-reminder-journey]] · [[../functions/retention]]
