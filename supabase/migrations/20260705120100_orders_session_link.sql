-- First-class order ↔ session link (experiment-session-stamped-attribution Phase 2).
-- The orders table had no session_id / anonymous_id — only cart_token — so an order
-- could only reach its session indirectly (orders.cart_token → order_placed event →
-- session_id). Persist the converting session directly so attribution joins it literally
-- (orders.session_id → storefront_sessions.experiment_assignments) and the order-detail
-- Journey panel can render the funnel without the indirect join.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS session_id uuid REFERENCES public.storefront_sessions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS anonymous_id text;

CREATE INDEX IF NOT EXISTS orders_session_id_idx ON public.orders (session_id);
