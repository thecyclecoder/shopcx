-- Backfill-order-refunds-ledger-from-history Phase 1 — add the
-- `source` marker to public.order_refunds so backfill rows are
-- distinguishable from live-fire mirror rows.
--
-- The mirror (20260918120000_order_refunds_mirror.sql, PR #1265) is
-- written on the success side of refundOrder() and only sees refunds
-- FIRED after that shipped. Historical refunds (returns.refunded_at
-- populated pre-mirror) are absent — the ledger is not yet a complete
-- audit record. Phase 1 of this spec backfills structured refunds from
-- the returns table; Phase 2 will do a best-effort backfill from
-- customer_events order.refunded rows.
--
-- source = 'live'     — inserted by refundOrder() on a successful
--                       vendor call (the write-on-fire path).
-- source = 'backfill' — inserted by a scripts/backfill-order-refunds-*
--                       run from a historical source (returns table,
--                       customer_events).
--
-- Default is 'live' so existing refundOrder() inserts (which don't
-- yet set source) keep working unchanged — the backfill scripts set
-- it explicitly. The CHECK constraint prevents a future caller from
-- silently drifting to a third value without updating the schema.

alter table public.order_refunds
  add column if not exists source text not null default 'live'
    check (source in ('live', 'backfill'));

-- Backfill-audit queries filter by source (e.g. "how many rows did the
-- returns backfill land?", "is a given order_refunds row from history
-- or from a live vendor call?").
create index if not exists order_refunds_source_idx
  on public.order_refunds (source);
