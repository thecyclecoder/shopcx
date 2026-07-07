-- Refund-integrity Phase 1 — the order_refunds mirror table.
-- (docs/brain/specs/refund-integrity-order-refunds-mirror-verify-by-id-settlement-reconcile.md, Phase 1)
--
-- One row per authoritative refund we fire against a vendor
-- (Braintree, Shopify REST) or an internal-only accounting refund.
-- The mirror closes the Sonia Stevens SC132396 failure mode: the
-- vendor call succeeded but the write-back never landed, the
-- self-heal retry re-fired the refund, and the customer got refunded
-- twice. With this table + Phase 2's verify-by-refund-id lookup, a
-- retry sees the mirror row on the (order_id, request_key) pair and
-- short-circuits.
--
-- request_key is a stable, per-refund idempotency key —
-- coalesce(action.request_key, hash(order_id + amount_cents + reason))
-- computed by refundOrder() before the vendor call. The UNIQUE index
-- on (order_id, request_key) is the DB-level backstop for the
-- verify-by-refund-id guard: two racing inserts with the same key can
-- only produce one row.
--
-- Admin-only: RLS OFF. Every write comes from the server-side
-- refundOrder chokepoint via createAdminClient(); no anon read path.

create table if not exists public.order_refunds (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  -- Idempotency key. Two rows with the same (order_id, request_key) is
  -- forbidden by the unique index below — the DB-level double-refund
  -- guard.
  request_key text not null,
  -- 'braintree'  — refundBraintreeTransaction path (internal orders +
  --                Shopify orders paid via the dead Shopify↔Braintree
  --                gateway).
  -- 'shopify'    — partialRefundByAmount native Shopify REST refund.
  -- 'internal'   — bookkeeping-only refund with no external vendor
  --                (dollar-replacement credits, offsets that resolve
  --                without a real refund).
  vendor text not null check (vendor in ('braintree', 'shopify', 'internal')),
  -- The vendor's refund id (Braintree transaction id / Shopify refund
  -- id). Nullable for 'internal' vendor. Populated on success; the
  -- Phase 3 reconcile queries against this id.
  vendor_refund_id text,
  amount_cents int not null,
  -- 'requested' — row inserted before the vendor call (not used yet;
  --               reserved so Phase 3 reconcile can distinguish
  --               "never confirmed" from "settled").
  -- 'succeeded' — vendor call returned success; write-on-fire lands here.
  -- 'failed'    — vendor call returned an error (reserved for future
  --               write-on-fail; today refundOrder returns early on
  --               failure so no mirror row is written).
  -- 'settled'   — Phase 3 T+3d reconcile confirmed settled state.
  -- 'reversed'  — a subsequent operation reversed the refund
  --               (chargeback reversal, etc.).
  status text not null check (status in ('requested', 'succeeded', 'failed', 'settled', 'reversed')),
  requested_at timestamptz not null default now(),
  settled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The double-refund guard — one row per (order_id, request_key).
create unique index if not exists order_refunds_order_request_key
  on public.order_refunds (order_id, request_key);

-- Phase 3 cron predicate: succeeded rows aged 3+ days waiting for
-- settlement. Also serves the tickets-detail refund-line lookup.
create index if not exists order_refunds_status_requested_at_idx
  on public.order_refunds (status, requested_at);

-- Workspace-scoped list queries (never cross-tenant).
create index if not exists order_refunds_workspace_order_idx
  on public.order_refunds (workspace_id, order_id);

-- RLS off — admin-only, per the spec.
alter table public.order_refunds disable row level security;
