-- create_order_refunds — the missing table for the refund idempotency guard + mirror ledger.
--
-- PR #1265 (refund-idempotency-guard-in-commerce-refund-facade) merged the CODE that reads/writes
-- public.order_refunds (src/lib/refund.ts refundOrder pre-dispatch guard + write-on-fire mirror, the
-- action-executor refund handlers, returnsIssueRefund) and the brain page docs/brain/tables/order_refunds.md,
-- but shipped NO migration to create the table — the spec-test mocks the Supabase client so the gap passed
-- green. Result on main: refundOrder's guard read returns null (missing table → error ignored, refund still
-- fires) and the mirror insert silently fails — the guard is inert. This migration creates the table exactly
-- as the merged code + brain page expect, so the already-merged guard becomes functional.
--
-- Schema authored to match docs/brain/tables/order_refunds.md and the refundOrder insert/select columns.
-- Additive, idempotent (IF NOT EXISTS). RLS ENABLED with no policies = admin-only (every write goes through
-- refundOrder via createAdminClient(), which bypasses RLS) — satisfies check:rls-on-new-tables and the brain
-- page's "RLS off, admin-only, no anon read path" intent.

create table if not exists public.order_refunds (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces(id) on delete cascade,
  order_id         uuid not null references public.orders(id) on delete cascade,
  request_key      text not null,
  vendor           text not null check (vendor in ('braintree', 'shopify', 'internal')),
  vendor_refund_id text null,
  amount_cents     integer not null,
  status           text not null check (status in ('requested', 'succeeded', 'failed', 'settled', 'reversed')),
  requested_at     timestamptz not null default now(),
  settled_at       timestamptz null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- The DB-level double-refund backstop: a same-shape retry hits this unique constraint and lands in
-- refundOrder's best-effort try/catch (the money already moved; Phase 3 reconcile catches drift).
create unique index if not exists order_refunds_order_request_key_uidx
  on public.order_refunds (order_id, request_key);

-- Phase 3 T+3d settlement reconcile predicate (status='succeeded' and requested_at < now() - 3 days).
create index if not exists order_refunds_status_requested_at_idx
  on public.order_refunds (status, requested_at);

-- Ticket-detail refund-line lookup (workspace_id, order_id).
create index if not exists order_refunds_workspace_order_idx
  on public.order_refunds (workspace_id, order_id);

-- Admin-only: RLS on with an explicit service_role full-access policy (house convention). Every write
-- goes through refundOrder via createAdminClient() (service role); there is no anon/member read path.
alter table public.order_refunds enable row level security;
drop policy if exists order_refunds_service on public.order_refunds;
create policy order_refunds_service on public.order_refunds
  for all to service_role using (true) with check (true);

comment on table public.order_refunds is
  'Refund mirror + idempotency ledger — one row per authoritative refund fired via refundOrder (the sole refund chokepoint). Pre-dispatch guard reads (workspace_id, order_id, request_key) in (succeeded, settled) and short-circuits; write-on-fire mirror inserts on vendor success; unique (order_id, request_key) is the DB backstop. Created by 20260917120000 to back the code merged in PR #1265, which shipped without this migration. See docs/brain/tables/order_refunds.md.';
comment on column public.order_refunds.request_key is
  'Idempotency key: coalesce(action request_key, hashRefundRequestKey(order_id + amount_cents + reason)). Same-shape retry => same key => unique index short-circuits.';
comment on column public.order_refunds.vendor is
  'Dispatch decision: braintree (internal or Shopify-paid-via-dead-Braintree-gateway) | shopify (native REST refund) | internal (accounting-only). Never inferred from orders.financial_status.';
comment on column public.order_refunds.status is
  'requested | succeeded | failed | settled | reversed. Phase 1 writes succeeded; Phase 3 T+3d reconcile flips to settled / catches reversed.';
