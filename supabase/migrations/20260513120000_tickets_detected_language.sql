-- Detected primary language of the customer on this ticket. Set on
-- the first inbound message via a Haiku detection call, then read by
-- the orchestrator + the playbook/macro send path so outbound copy
-- gets translated before delivery. ISO 639-1 codes; default 'en'.

ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS detected_language TEXT;
