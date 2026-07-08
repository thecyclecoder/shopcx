-- ticket_analyses.billing_source — nullable text tag for whether the run that
-- produced this row was billed against the Max subscription (a box lane, $0
-- marginal) or against a real per-token API bill (the deployed analyzer's
-- fallback path when the box is down). Mirrors the apiBilled contract on
-- fleet-cost.recordAgentJobCost ([[../libraries/fleet-cost]]) — same signal,
-- persisted per-ticket so Phase 2's cost computation can suppress a fabricated
-- dollar figure on a Max run.
--
-- Nullable on purpose: historical rows (produced before this column existed)
-- read as UNKNOWN rather than being retroactively mislabelled. Phase 2 will
-- treat a null value the same as 'max' for cost purposes, but the row itself
-- carries the honest "we didn't record it" tag.
--
-- Constrained via CHECK so a caller can't smuggle a third value; the two
-- allowed values ('max' | 'api') match the fleet-cost apiBilled flag: 'max'
-- ↔ apiBilled=false, 'api' ↔ apiBilled=true.
--
-- See: docs/brain/specs/ticket-cost-distinguishes-max-subscription-from-real-api-spend.md § Phase 1.

alter table public.ticket_analyses
  add column if not exists billing_source text
    check (billing_source in ('max', 'api'));

comment on column public.ticket_analyses.billing_source is
  'How the analyzer run that produced this row was billed. ''max'' = Max-subscription box lane ($0 marginal — apiBilled=false); ''api'' = deployed analyzer against the paid API (apiBilled=true). Null = historical (unknown). Mirrors fleet-cost.apiBilled.';
