# `pre_renewal_reminders` — one row per (customer group, renewal window) reminder decision

The send-ledger for the pre-renewal reminder channel. One row per customer **identity group** per renewal, stamped with the experiment arm — the attributable record the M3 primary metric (90-day net revenue per customer, reminder group vs holdout) and the opt-out/complaint guardrails read. Written + read ONLY through [[../libraries/pre-renewal-reminders]] (CLAUDE.md raw-`.from` chokepoint). Migration `20270122120000_pre_renewal_reminders.sql`. RLS: service-role only. Part of the [[../lifecycles/pre-renewal-reminder-journey]] flow (M2 "Renewal reminder sends"). Spec: `pre-renewal-reminder-sends`.

**Holdout rows record the DECISION, not a send** — a `holdout` row is the clean counterfactual (we decided-not-to-remind). `treatment` rows carry the email + consented-SMS outcome. Every intended + actual send is here.

**Primary key:** `id` · **Idempotency guard:** `UNIQUE (workspace_id, group_id, renewal_window_key)` — the atomic double-send guard. A re-run, or the same sub seen on consecutive days while still in the window, conflicts on this key and is a no-op (never re-sends).

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | default `gen_random_uuid()` |
| `workspace_id` | uuid → [[workspaces]] | cascade |
| `group_id` | uuid | the [[customer_links]] `group_id` (or the customer's own id when unlinked) — the PERSON grain the [[../libraries/subscriber-experiments]] harness assigns on. Never a bare per-account id. |
| `customer_id` | uuid → [[customers]] | a representative account in the group (the earliest-renewing sub's customer) — the email/phone/journey owner |
| `renewal_window_key` | text | dedupe key: the earliest in-window `next_billing_date` (YYYY-MM-DD) among the group's selected subs. Stable across daily re-scans of the window |
| `next_billing_date` | date | the renewal this reminder is for |
| `experiment_arm` | text | `treatment` \| `holdout`. From [[../libraries/subscriber-experiments]] `assignArm` (sticky, assigned once at first eligibility) |
| `channels` | text[] | channels actually attempted — subset of `['email','sms']` |
| `status` | text | `pending` (treatment mid-send) → `sent`; `holdout`; `skipped` (no arm / no journey) |
| `journey_session_id` | uuid → [[journey_sessions]] | the minted next-order journey session (set null on delete) |
| `journey_token` | text | the journey token both channels link to |
| `email_status` | text | `sent` \| `failed` \| null (not attempted) |
| `email_sent_at` | timestamptz | — |
| `email_error` | text | failure detail |
| `sms_status` | text | `sent` \| `scheduled` \| `suppressed_no_consent` \| `suppressed_stop` \| `failed` \| null |
| `sms_suppression_reason` | text | why no SMS (non-consent / STOP / bad phone) — read by the M3 opt-out guardrail |
| `sms_resolved_timezone` | text | IANA tz the send instant used |
| `sms_timezone_source` | text | `customer_explicit` \| `address_zip` \| `phone_area_code` \| `fallback` ([[../libraries/marketing-text-timezone]]) |
| `sms_scheduled_send_at` | timestamptz | the per-recipient local send instant (Twilio SendAt) |
| `sms_error` | text | failure detail |
| `previewed_amount_cents` | integer | the FULL amount the reminder stated the renewal would charge — merchandise after discounts + shipping + protection + tax (summed across the group's in-window subs), from [[../libraries/pre-renewal-reminders]] `reminderChargePreview`. The base (merch+discounts+shipping+protection) resolves through the ONE money resolver `priceSubscription` ([[../libraries/commerce__price]]) for every engine, then tax is layered on top (internal subs add `ensureFreshSubscriptionTaxQuote().tax_cents` via Avalara 'total'; shopcx subs show base 'plus tax' as Shopify taxes at billing). Null when no amount could be resolved (the reminder then omits it rather than guessing). Stamped so a mismatch with the actual renewal charge can be audited. Migration `20270123120001_pre_renewal_reminders_previewed_amount.sql`. |
| `previewed_includes_tax` | boolean | whether `previewed_amount_cents` already INCLUDES tax: `true` when every resolved-amount preview was a tax-inclusive 'total', `false` when any was a pre-tax 'plus tax' estimate (shopcx subs, or an Avalara quote that couldn't resolve), `null` when no amount resolved. Lets the launch audit distinguish an exact figure from a pre-tax one. Migration `20270124120000_pre_renewal_reminders_previewed_includes_tax.sql`. |
| `created_at` / `updated_at` | timestamptz | — |

## Who writes it

[[../libraries/pre-renewal-reminders]] `runPreRenewalRemindersForWorkspace` — inserts the row (unique-guard), then on the treatment path stamps the email + SMS outcome. Driven by the daily [[../inngest/pre-renewal-reminders]] cron.

## Gotchas

- **The insert is the guard, not a proxy** — the row is inserted BEFORE any send so a unique-violation (`23505`) cleanly means "already reminded" and no second send fires. Don't move the send ahead of the insert.
- **Holdout ≠ skipped.** `holdout` = assigned to the counterfactual (intentional no-send). `skipped` = no arm resolved (experiment not running / kill switch off) or no active next-order journey. Different rows, different meaning for the metric.
- **Dormant until the experiment exists.** `assignArm` returns null when the `pre-renewal-reminder` experiment row isn't created for the workspace → every group `skipped`, no ledger rows. Launching the test (creating the experiment) turns the channel on.
