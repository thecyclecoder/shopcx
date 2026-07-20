-- Phase 3 of shopify-order-confirmation-emails.
--
-- Track that a confirmation was sent (proves we sent it + serves as
-- the dedupe key for the Phase-4 queued sender: a non-null
-- `order_confirmation_email_id` means "already sent — no-op").
--
-- Also links `email_events` back to the source order so the existing
-- resend-events pipeline (`/api/webhooks/resend-events`) records
-- delivered/opened for order-confirmation sends alongside customer
-- + ticket events (no `metadata.order_id` stashing — real column so
-- lookups can index-scan).

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS order_confirmation_email_id text NULL,
  ADD COLUMN IF NOT EXISTS order_confirmation_sent_at timestamptz NULL;

ALTER TABLE public.email_events
  ADD COLUMN IF NOT EXISTS order_id uuid NULL
    REFERENCES public.orders(id) ON DELETE SET NULL;

-- Index the FK for the /api/workspaces/[id]/delivery-stats-style
-- per-order lookups the confirmation-send pipeline needs. Kept
-- non-unique because `email_events` records multiple events per
-- resend id (sent → delivered → opened → clicked).
CREATE INDEX IF NOT EXISTS email_events_order_id_idx
  ON public.email_events (order_id)
  WHERE order_id IS NOT NULL;
