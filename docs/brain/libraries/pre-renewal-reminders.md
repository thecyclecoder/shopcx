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
| `planReminderSmsSend(customer, now)` | PURE — the quiet-hours scheduling decision (`SmsSendDecision`): `{send:true, sendAt, timezone, source}` for a verified zone with a 9 AM–8 PM-local SendAt, else `{send:false, smsStatus:'suppressed_no_timezone'\|'suppressed_quiet_hours', …}`. |
| `buildReminderSmsBody(preview, journeyUrl)` | PURE — the house block layout body (hook / `Review your order:` + link / deadline), GSM-7, never a word-blob. |
| `classifySmsConsent(customer)`, `fmtPreviewAmount(preview)`, `reminderChargePreview(...)` | PURE consent gate / amount render / exact charge preview. |
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

### Hard 9 AM–8 PM local send window (TCPA, launch-readiness Phase 1)

A reminder text is only ever **scheduled** for an instant provably between **9:00 AM and 8:00 PM in the recipient's verified local time** — never sent immediately, never into a guessed/unknown zone. The decision is the PURE, exported `planReminderSmsSend(customer, now)`:

- **No verified timezone → no text (email only).** If `resolveRecipientTimezone` fell back to the workspace default (`source==='fallback'`) OR the resolved zone is not a valid IANA name (`isValidIanaTimezone` false), the recipient gets `suppressed_no_timezone` and only the email. This closes two breaches: a Hawaii/Alaska customer who fell back to `America/Chicago` got the 11 AM Central text at 7–8 AM local, and an invalid `customers.timezone` string was silently treated as UTC (`getTimezoneOffsetMinutes` returns 0 for unknown zones) so 11:00 UTC was already past at the 13:00 UTC cron and the text went out immediately at 8 AM Eastern.
- **Target 11:00 on the recipient's LOCAL calendar date** (`localDateKey` → `computeSendInstant`), targeting `PRE_RENEWAL_SMS_LOCAL_HOUR` (11:00). If that instant is already past or `<16 min` away (`SMS_MIN_SCHEDULE_LEAD_MS`), roll to **11:00 local TOMORROW** (Twilio `SendAt` allows up to 7 days). We **always** return a `SendAt` — a passed slot can never fall through to an immediate (possibly-night) send.
- **Fail-closed guard.** Immediately before `sendSMS`, `maybeSendConsentedSms` re-asserts `isWithinSmsSendWindow(sendAt, tz)` ([[marketing-text-timezone]], window = `[SMS_WINDOW_START_HOUR 9, SMS_WINDOW_END_HOUR 20)`); if it ever fails (DST / resolver edge) the send is suppressed `suppressed_quiet_hours` rather than risk a breach. 11:00 local always passes, so this is defense-in-depth.

The send goes via [[twilio]] `sendSMS` **always with `SendAt`**. The ledger records `channel='sms'`, `sms_resolved_timezone` + `sms_timezone_source`, `sms_scheduled_send_at`, and the suppression reason (`suppressed_no_timezone` / `suppressed_quiet_hours` / consent reasons).

### House SMS block layout

The body is built by the PURE, exported `buildReminderSmsBody(preview, journeyUrl)` following the house layout (sms-marketing SKILL.md step 4): a short **hook** block (what renews + when + the amount label from the preview), a blank line, a **CTA label** line (`Review your order:`) with the **link on its own line** in the middle, a blank line, then a short **deadline** line (`Make changes before {date}.`). GSM-7 only — straight quotes, no em dashes, no emoji — and never a single word-blob. A comped renewal reads "and it is on us", never a bare `$0.00`.

## Exact charge preview — one money resolver, every engine (launch-readiness Phase 2 · follow-ups)

`reminderChargePreview(workspaceId, subscriptionId)` → `{ nextBillingDate, items[], amountCents | null, shippingCents | null, taxCents | null, amountLabel: 'total' | 'plus tax', comp }`. `amountCents` is the FULL amount the renewal will charge — merchandise after discounts + shipping + protection + tax — so a customer never sees one number and is charged a higher one (CEO follow-up 2026-11-22), and it matches the number the Portal shows for the same sub.

The **base** (merch after discounts + shipping + protection) comes from the ONE money resolver `priceSubscription` ([[commerce__price]], `src/lib/commerce/price.ts`) for **every** engine — the same resolver the Portal / mini-site / dashboard use. This fixes the CEO 2026-11-23 bug: ShopCX-engine subs carry `price_cents` lines (the Appstle shape, [[commerce__shopcx-line-ops]]), so the old hand-summed `items[].price` resolved every ShopCX sub (most of MRR) to no amount. A `PriceInvariantError` (a line that can't be priced) ⇒ `amountCents=null` (omit rather than guess). Tax is then layered on the base, never re-derived:

- **internal subs** → layer the renewal path's OWN tax quote on top of the base. `ensureFreshSubscriptionTaxQuote` ([[avalara-subscription]]) returns `{ tax_cents }`; the full charge is `base + tax_cents` (`amountLabel='total'`). We QUOTE only (SalesOrder, commit=false); no filing. Avalara enabled but no quote ⇒ base shown `'plus tax'`; Avalara disabled ⇒ $0 tax so the base IS the full charge (`taxCents=0`, `'total'`).
- **shopcx subs** → Shopify computes + applies tax AT billing ([[../inngest/shopify-subscription-renewals]]), so it can't be quoted exactly here: the base is the resolver total, `taxCents=null`, `amountLabel='plus tax'`.
- **comped subs** (`sub.comp`, or a resolver total of 0 with every product line at $0) → `comp=true`, amount 0; copy reads **"This order is on us"**, never a bare `"$0.00"`.

`amountCents` is null only when the base can't be resolved — the reminder then OMITS the amount rather than guessing. Copy renders a `'plus tax'` preview as `"$X plus tax"`, a comped sub as `"This order is on us"`, never a bare pre-tax number or `$0.00` (email + SMS both, via `fmtPreviewAmount`). Shipping Protection lines stay out of `items[]` but their charge rides in the total (it's in `priceSubscription`'s `total_cents`). `sendTreatmentReminder` builds one preview per in-window sub, renders them into the email `contextMessage` + a short SMS (date + amount + link), and stamps the summed `previewed_amount_cents` **plus `previewed_includes_tax`** on the ledger row for later charge-vs-preview audit.

The next-order journey total ([[next-order-journey-builder]]) resolves non-internal subs through the SAME `priceSubscription` (`pricing.total_cents`), so the journey editor, the reminder, and the Portal all show one number.

## Status is the on/off switch (launch-readiness Phase 4)

`runPreRenewalRemindersForWorkspace` fetches the experiment once and returns early unless `isExperimentRunning` ([[subscriber-experiments]]) — a `draft`/`stopped`/`complete` workspace is a cheap no-op (no subscription scan), and the cron still heartbeats.

## Node completeness

Owner `retention` in [[control-tower-node-registry]] / `MONITORED_LOOPS`; kill switch resolved via ancestry and honoured in `runPreRenewalReminders`; heartbeat every tick from the [[../inngest/pre-renewal-reminders]] cron.
