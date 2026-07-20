-- Self-healing return refunds — Phase 1 reconcile.
-- Track the audit shortfall when the live Shopify ledger's refundable
-- balance is smaller than the return's stored contract. `net_refund_cents`
-- remains the intent — this column records the delta the gateway ceiling
-- forced us to leave on the table (SC133086 / SC129432).
-- Nullable by design: null == "not capped" (the common case).
alter table public.returns
  add column if not exists refund_shortfall_cents integer;

comment on column public.returns.refund_shortfall_cents is
  'Amount (cents) the live gateway refundable ceiling was short of net_refund_cents at refund time. Null when the contract refunded in full. Set by returnsIssueRefund reconcile.';
