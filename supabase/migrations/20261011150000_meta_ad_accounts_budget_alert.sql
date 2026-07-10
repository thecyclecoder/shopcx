-- Budget-increase SMS tripwire (CEO 2026-07-10): text the founder whenever an ad account's TOTAL active
-- daily budget climbs (a new test running, a raised budget, or a runaway) so he can spot crazy spend
-- while traveling. This column stores the last-seen total we compared against, per account. See
-- docs/brain/libraries/budget-alerts + inngest/budget-watch.
alter table public.meta_ad_accounts
  add column if not exists last_notified_daily_budget_cents bigint;

comment on column public.meta_ad_accounts.last_notified_daily_budget_cents is
  'Budget-watch tripwire: the total active daily budget (cents) last observed for this account. The budget-watch cron SMSes the founder when the current total exceeds this, then updates it. NULL = never checked.';
