-- Tracks whether the one-and-done chargeback notice has been sent
-- to this customer. Used by the orchestrator's chargeback gate to
-- avoid replying more than once. Once a chargeback is filed we send
-- a single canonical message and then close silently on every future
-- inbound from the same customer.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS chargeback_notice_sent_at TIMESTAMPTZ;
