-- Configurable support email for ticket replies (reply-to address)
ALTER TABLE public.workspaces
  ADD COLUMN support_email TEXT;
