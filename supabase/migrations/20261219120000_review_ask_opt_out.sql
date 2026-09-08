-- "Don't ask me again" for review requests (CEO 2026-09-08).
--
-- A review ask is a favour, not marketing. Someone who does not want to be asked
-- should be able to say so in one click WITHOUT losing their marketing email —
-- opting out of a review request is a much narrower intent than unsubscribing,
-- and conflating the two takes more from the customer than they asked to give.
--
-- Nullable timestamp rather than a boolean so the audit answers "when", and so
-- an un-set value is unambiguously "never opted out" rather than a default.
alter table public.customers
  add column if not exists review_asks_opted_out_at timestamptz;

comment on column public.customers.review_asks_opted_out_at is
  'When the customer clicked "don''t ask me again" on a review request. Non-null = never send another review ask. Narrower than an email unsubscribe on purpose: marketing email is untouched. Set by /api/review/[token]/stop; read by review-request-sender before composing.';

-- The sender checks this on every candidate, so keep the lookup cheap and only
-- index the rows that actually carry a value.
create index if not exists customers_review_asks_opted_out_idx
  on public.customers (workspace_id)
  where review_asks_opted_out_at is not null;
