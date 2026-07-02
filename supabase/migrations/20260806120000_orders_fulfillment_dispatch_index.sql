-- orders_fulfillment_dispatch_index — kill the full-table seq scan behind the Amplifier
-- fulfillment-dispatch queue (paid orders not yet handed to Amplifier).
--
-- The query `WHERE workspace_id = X AND financial_status = 'paid' AND amplifier_order_id IS NULL
-- AND (fulfillment_status IS NULL OR fulfillment_status <> 'fulfilled')` matches only a HANDFUL of
-- rows but, with no covering index, Seq Scans all ~133k orders in the workspace (~1.35s locally,
-- ~2.9s under prod load — a prime statement_timeout / temp-spill offender during load bursts).
--
-- A partial index over exactly the actionable subset is tiny (a few rows / ~16 kB) and turns the
-- query into a workspace_id + created_at Index Scan: measured 1351ms -> 0.77ms.
--
-- CONCURRENTLY (issued by the apply-script, one statement, never in a txn) so it never locks the
-- hot orders table. Idempotent via IF NOT EXISTS.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_pending_amplifier_dispatch
  ON public.orders (workspace_id, created_at DESC)
  WHERE amplifier_order_id IS NULL
    AND financial_status = 'paid'
    AND (fulfillment_status IS NULL OR fulfillment_status <> 'fulfilled');
