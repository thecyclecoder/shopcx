-- dunning_cycles.closed_reason — why a cycle was closed WITHOUT dunning having given up.
--
-- `endDunningForSubscription` closes open cycles when the customer pauses or cancels their
-- subscription. It first recorded that in `terminal_error_code`, which was wrong twice over:
--
--  1. The dunning analytics panel (src/app/api/workspaces/[id]/analytics/dunning/route.ts)
--     counts `status='exhausted' AND terminal_error_code IS NOT NULL` as "terminal
--     cancellations" — subs killed BY dunning. A customer-initiated pause is not one, so
--     every such close inflated that number.
--  2. dunning-new-card-recovery Step 1b selects `status='exhausted'` cycles whose sub is
--     `cancelled`, then RESUMES and CHARGES them — deliberately, to reactivate a
--     dunning-cancelled sub. A customer-initiated cancel produces the identical shape, so a
--     later card update would resume and bill a subscription the customer had ended. Step 1b
--     now excludes rows carrying a closed_reason.
--
-- Separating the field keeps "dunning gave up" and "the customer left" distinguishable, which
-- both surfaces need.
--
-- See docs/brain/lifecycles/dunning.md § A pause or cancel ENDS dunning.

alter table public.dunning_cycles
  add column if not exists closed_reason text;

comment on column public.dunning_cycles.closed_reason is
  'Set when a cycle is closed because the SUBSCRIPTION was paused/cancelled by the customer, not because dunning exhausted. Keeps such rows out of the terminal-cancellation analytics and out of new-card-recovery reactivation.';

-- Move the values already written by the 2026-09-09 backfill out of terminal_error_code.
update public.dunning_cycles
set closed_reason = terminal_error_code, terminal_error_code = null
where terminal_error_code like 'subscription_%' and closed_reason is null;
