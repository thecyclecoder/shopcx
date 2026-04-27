-- Optional page-context payload for tickets started from a specific page
-- (e.g. storefront PDP). Sonnet reads this to know "the customer is asking
-- from the Amazing Coffee PDP" without us cluttering the conversation history
-- with a synthetic system note.
ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS page_context JSONB;
