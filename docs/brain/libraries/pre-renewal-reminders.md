# libraries/pre-renewal-reminders

The logic behind the retention **pre-renewal reminder channel** — the eligibility scan, dedupe, arm resolution, ledger writes, and the email + consented-SMS sends. The SINGLE chokepoint for the [[../tables/pre_renewal_reminders]] ledger (all `.from("pre_renewal_reminders")` access lives here). Driven by the daily [[../inngest/pre-renewal-reminders]] cron. Spec: `pre-renewal-reminder-sends`.

**File:** `src/lib/pre-renewal-reminders.ts`

## Exports

| Symbol | What |
|---|---|
| `runPreRenewalReminders(now?, admin?)` | Top-level daily run. Honours the cron kill switch (OFF ⇒ no sends), then fans out across every workspace. Returns per-channel counts (`PreRenewalRunResult`). |
| `runPreRenewalRemindersForWorkspace(workspaceId, now, admin?)` | One workspace: arm → ledger insert (unique-guard) → treatment email + SMS. |
| `scanEligibleReminders(workspaceId, now, admin?)` | Phase 1 — the deduped reminder audience (`ReminderGroup[]`): active subs renewing in the window, minus dunning + just-edited subs, collapsed to one group per person. |
| `PRE_RENEWAL_REMINDER_LOOP_ID` | `"pre-renewal-reminder-cron"` — the control-tower loop_id / node id. |
| `PRE_RENEWAL_WINDOW_DAYS` (5), `PRE_RENEWAL_RECENT_EDIT_DAYS` (3), `PRE_RENEWAL_SMS_LOCAL_HOUR` (11) | Tunables. |

The experiment slug (`pre-renewal-reminder`) is `PRE_RENEWAL_EXPERIMENT_SLUG`, exported from [[subscriber-experiments]] (it owns the experiment spine).

## Phase 1 — eligibility scan + dedupe

`scanEligibleReminders` selects `subscriptions` with `status='active'`, `billing_source` in (`shopcx`,`internal`), `next_billing_date` in `[now+4d, now+6d]` (a ±1 day band around 5 days so a missed tick still catches the renewal). It then:

- **Excludes active dunning** — a sub with a [[../tables/dunning]] `dunning_cycles` row in status `active`/`skipped`/`paused` belongs to the dunning path, not a next-order nudge.
- **Excludes just-edited subs** — `updated_at` within `PRE_RENEWAL_RECENT_EDIT_DAYS` was already acted on.
- **Collapses to one reminder per person** — resolves each sub's customer to its [[../tables/customer_links]] `group_id` and keeps one group, `renewal_window_key` = the earliest in-window `next_billing_date` (YYYY-MM-DD), stable across daily re-scans.

## Arm + ledger (the double-send guard)

Per group, `assignArm(ws, PRE_RENEWAL_EXPERIMENT_SLUG, customerId)` ([[subscriber-experiments]]) returns the sticky arm (assigned once at first eligibility, honours the harness switch) or null (experiment not running / switch off → `skipped`). The ledger row is inserted BEFORE any send — a `23505` unique-violation on `(workspace_id, group_id, renewal_window_key)` cleanly means "already reminded" and no second send fires (guard-before-mutation, not a proxy). Holdout rows stop here (`status='holdout'`).

## Phase 2 — transactional email

Treatment mints a next-order [[../tables/journey_sessions]] session (slug `next-order`, `ticket_id` null — proactive, not ticket-born) with the earliest sub pre-selected, then sends the CTA via [[email]] `sendJourneyCTA` ([[../integrations/resend]]). One CTA per customer per renewal (the one-CTA-equals-one-mini-site principle). Email is transactional — goes to every treatment customer regardless of marketing consent. The ledger records `channel='email'` + the send result.

## Phase 3 — consented SMS with timezone / quiet-hours + STOP

`maybeSendConsentedSms` gates the text on marketing consent:

- `sms_marketing_status='unsubscribed'` (customer sent STOP via the Twilio inbound → marketing-consent path, [[../integrations/twilio]]) → `suppressed_stop`.
- not `subscribed`, no phone, or a bad `phone_status` → `suppressed_no_consent`.
- Never texts a suppressed or non-consented customer (TCPA). Suppressions are counted on the ledger so the M3 opt-out/complaint guardrails can read them.

For a consented recipient it computes the per-recipient local send instant with `resolveRecipientTimezone` + `computeSendInstant` ([[marketing-text-timezone]]) targeting `PRE_RENEWAL_SMS_LOCAL_HOUR` (11:00) local — a business-hours hour, so quiet hours are never breached. The send goes via [[twilio]] `sendSMS` with Twilio `SendAt` when the window is ≥16 min out, else immediately. Same journey CTA link as the email (plain text + URL). The ledger records `channel='sms'`, the resolved timezone + source, and the scheduled instant.

## Exact charge preview — full charge incl. tax + shipping (launch-readiness Phase 2 · follow-up Phase 1)

`reminderChargePreview(workspaceId, subscriptionId)` → `{ nextBillingDate, items[], amountCents | null, shippingCents | null, taxCents | null, amountLabel: 'total' | 'plus tax' }`. `amountCents` is the FULL amount the renewal will charge — merchandise after discounts + shipping + tax — so a customer never sees one number and is charged a higher one (CEO follow-up 2026-11-22). It uses the SAME path the renewal bills for that engine:

- **internal subs** → the renewal path's OWN tax quote. `ensureFreshSubscriptionTaxQuote` ([[avalara-subscription]]) returns `{ tax_cents, total_cents }` where `total_cents` already is merch − discount + shipping + protection + tax — the exact charge (`amountLabel='total'`). We QUOTE only (SalesOrder, commit=false); no filing. When Avalara is enabled but the quote can't resolve, we fall back to pre-tax merch+shipping labelled `'plus tax'`; when Avalara is disabled the renewal charges $0 tax so the pre-tax base IS the full charge (`taxCents=0`, `'total'`).
- **shopcx subs** → Shopify computes + applies tax AT billing ([[../inngest/shopify-subscription-renewals]]), so it can't be quoted exactly here: merchandise = stored contract-line prices, shipping = contract delivery price, `taxCents=null`, `amountLabel='plus tax'`.

`amountCents` is null only when even the pre-tax base can't be resolved — the reminder then OMITS the amount rather than guessing. Copy renders a `'plus tax'` preview as `"$X plus tax"`, never a bare pre-tax number (email + SMS both). Shipping Protection lines stay out of `items[]` but their charge rides in the total (it's in the quote's `total_cents`). `sendTreatmentReminder` builds one preview per in-window sub, renders them into the email `contextMessage` + a short SMS (date + amount + link), and stamps the summed `previewed_amount_cents` **plus `previewed_includes_tax`** on the ledger row for later charge-vs-preview audit.

## Status is the on/off switch (launch-readiness Phase 4)

`runPreRenewalRemindersForWorkspace` fetches the experiment once and returns early unless `isExperimentRunning` ([[subscriber-experiments]]) — a `draft`/`stopped`/`complete` workspace is a cheap no-op (no subscription scan), and the cron still heartbeats.

## Node completeness

Owner `retention` in [[control-tower-node-registry]] / `MONITORED_LOOPS`; kill switch resolved via ancestry and honoured in `runPreRenewalReminders`; heartbeat every tick from the [[../inngest/pre-renewal-reminders]] cron.
