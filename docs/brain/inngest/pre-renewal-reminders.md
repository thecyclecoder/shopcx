# inngest/pre-renewal-reminders

The retention **pre-renewal reminder channel** — a daily cron that, ~5 days before each subscription's next billing date, reminds the treatment arm and drops them into the next-order journey. The reminder the M2/M3 retention test measures. Thin wrapper — the logic lives in [[../libraries/pre-renewal-reminders]].

**File:** `src/lib/inngest/pre-renewal-reminders.ts`

## Functions

### `pre-renewal-reminder-cron`
- **Trigger:** cron `0 13 * * *` (13:00 UTC — daily)
- **Retries:** 1
- Calls [[../libraries/pre-renewal-reminders]] `runPreRenewalReminders(new Date())`, which fans out across every workspace. **Heartbeat on every tick** (incl. the no-eligible-subs and kill-switch-off paths — no early return) via `emitCronHeartbeat("pre-renewal-reminder-cron", …)`. `ok:false` when the effective kill switch tripped.
- **Timing is deliberate:** runs **AFTER** the morning subscription charge crons ([[internal-subscription-renewals]] / [[shopify-subscription-renewals]], `0 10 * * *`) so a sub charged today isn't also reminded.

## What a tick does (see [[../libraries/pre-renewal-reminders]])

1. Honour the cron's effective [[../tables/kill_switches]] switch — OFF ⇒ no sends, still heartbeat.
2. Per workspace: scan `active` subs renewing in the ~5-day window across both live engines (`billing_source` `shopcx` + `internal`), minus subs in an active [[../tables/dunning]] `dunning_cycles` cycle and subs edited in the last few days.
3. Collapse to one reminder per customer identity group ([[../tables/customer_links]] `group_id`), keyed on the earliest in-window `next_billing_date`.
4. Ask the [[../libraries/subscriber-experiments]] harness (`assignArm`, slug `pre-renewal-reminder`) for the arm. Only `treatment` is reminded; `holdout` gets nothing new.
5. Write a [[../tables/pre_renewal_reminders]] row (unique-guard), then for treatment: mint a next-order [[../tables/journey_sessions]] session, send the transactional email ([[../libraries/email]] `sendJourneyCTA`), and — for SMS-consented customers only — the consented, quiet-hours-respecting SMS.

## Node completeness (north star)

- **Owner:** `retention` — registered in [[../libraries/control-tower.md]] `MONITORED_LOOPS` (`pre-renewal-reminder-cron`), which gives it a [[../tables/kill_switches]] ancestry and an org-chart owner.
- **Kill switch:** resolved via the registry ancestry; `runPreRenewalReminders` reads `resolveEffectiveSwitch("pre-renewal-reminder-cron")` and no-ops on OFF.
- **Heartbeat:** `emitCronHeartbeat` every tick.

This is a DISTINCT job from the charge crons documented in [[internal-subscription-renewals]] — it never bills; it only reminds.
