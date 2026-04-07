-- Track pending sends — message is visible in UI but email not yet delivered
ALTER TABLE ticket_messages
  ADD COLUMN IF NOT EXISTS pending_send_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS send_cancelled BOOLEAN DEFAULT false;
