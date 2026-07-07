-- create_digital_good_deliveries — Phase 2 of digital-goods-delivery.
--
-- The delivery LEDGER for the post-purchase attachment email — one row per
-- (order, digital_good) pair the Phase 2 Inngest function has successfully
-- emailed. It is the DB-level idempotency guard behind the spec's "Idempotent
-- per (order, digital_good)" invariant:
--
--   1. Pre-dispatch guard: src/lib/inngest/digital-goods-delivery.ts reads
--      this table by (workspace_id, order_id, digital_good_id) BEFORE
--      the Resend send. A hit short-circuits the send — the customer's
--      inbox stays clean of duplicate PDFs on retry.
--   2. Write-on-fire mirror: on Resend success the function inserts the
--      row with resend_email_id + delivered_at. A row without
--      resend_email_id is legal (defensive best-effort), but the guarded
--      path always sets it.
--   3. DB backstop: unique (order_id, digital_good_id) — a race between
--      two retries hits this constraint and lands in the function's
--      try/catch (the email already went out; log and move on).
--
-- Additive, idempotent (IF NOT EXISTS + drop/create). RLS ENABLED with
-- a service_role full-access policy (house convention — every read/write
-- flows through the Inngest function via createAdminClient()).

create table if not exists public.digital_good_deliveries (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces(id) on delete cascade,
  order_id         uuid not null references public.orders(id) on delete cascade,
  digital_good_id  uuid not null references public.digital_goods(id) on delete cascade,
  resend_email_id  text null,
  delivered_at     timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- The DB-level idempotency backstop — a same-shape retry hits this constraint
-- and lands in the Inngest function's try/catch. Mirror-shape of the
-- order_refunds unique index (order_id, request_key).
create unique index if not exists digital_good_deliveries_order_good_uidx
  on public.digital_good_deliveries (order_id, digital_good_id);

-- Phase 3 portal-resend lookup: "does this customer's order still have the
-- delivery on file so I can resend it?" — bounded by workspace_id + order_id.
create index if not exists digital_good_deliveries_workspace_order_idx
  on public.digital_good_deliveries (workspace_id, order_id);

alter table public.digital_good_deliveries enable row level security;
drop policy if exists digital_good_deliveries_service on public.digital_good_deliveries;
create policy digital_good_deliveries_service on public.digital_good_deliveries
  for all to service_role using (true) with check (true);

comment on table public.digital_good_deliveries is
  'Delivery ledger for digital-goods post-purchase attachment emails — one row per (order, digital_good). Written by src/lib/inngest/digital-goods-delivery.ts on Resend success. The unique (order_id, digital_good_id) index + the pre-dispatch guard read enforce "exactly one email per (order, good)" per Phase 2 of digital-goods-delivery. See docs/brain/tables/digital_good_deliveries.md.';
comment on column public.digital_good_deliveries.resend_email_id is
  'Resend message id returned from resend.emails.send. Nullable to leave room for a defensive best-effort write if a future failure mode lands a ledger row without the id — the guarded happy path always sets it.';
comment on column public.digital_good_deliveries.delivered_at is
  'When the Resend send succeeded (post-dispatch), not when the guard was consulted. The Phase 3 portal-resend action uses this to render "last delivered" state.';
