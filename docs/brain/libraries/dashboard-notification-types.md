# dashboard-notification-types

The TypeScript mirror of the [[../tables/dashboard_notifications]] `dashboard_notifications_type_check` CHECK constraint.

**Code:** `src/lib/dashboard-notification-types.ts` · **Test:** `src/lib/dashboard-notification-types.test.ts` (`npm run test:dashboard-notification-types`)

## Exports

| Export | What |
|---|---|
| `DASHBOARD_NOTIFICATION_TYPES` | `readonly` tuple of every `type` the CHECK accepts |
| `DashboardNotificationType` | union of the tuple's members — annotate a `type:` with `satisfies DashboardNotificationType` (or type a constant with it) so `tsc` rejects an unlisted value |
| `isDashboardNotificationType(t)` | runtime guard |

## Why

An insert whose `type` the CHECK doesn't list is rejected (23514 → PostgREST 400), and nearly every notification insert is fire-and-forget, so the card is silently lost. 2026-09-28 → 2026-10-14: the 09:00 UTC [[../inngest/internal-subscription-renewals]] cron's [[dunning-strand-detector]] + [[subscription-duplicate-renewal-detector]] (and [[commerce__shopcx-renewal-price-check]]) wrote `type='billing_alert'`, never in the CHECK — fixed by migration `20270109120000_dashboard_notifications_billing_alert_and_auth_expired_types.sql`.

## The lockstep test

1. Tuple == the CHECK list parsed from the newest `supabase/migrations/*.sql` that `ADD CONSTRAINT dashboard_notifications_type_check`.
2. Scans `src/` + `scripts/` (non-test `.ts`/`.tsx`) for `.from("dashboard_notifications").insert|upsert(...)`; every top-level `type:` (literal, same-file `const`, or `APPROVAL_REQUEST_TYPE` / `DAILY_SUMMARY_TYPE`) must be in the tuple. An inline payload with no top-level `type` fails. A variable/builder payload must be named in the test's `VARIABLE_PAYLOAD_SITES` with the type its builder emits.

**Adding a type:** append to the tuple AND ship a migration that drops + re-creates the CHECK with the full superset. Never remove a value live rows carry.

## Callers

`src/lib/dunning-strand-detector.ts`, `src/lib/subscription-duplicate-renewal-detector.ts`, `src/lib/commerce/shopcx-renewal-price-check.ts`, `scripts/builder-worker.ts` (`AUTH_EXPIRED_ALERT_TYPE`).
