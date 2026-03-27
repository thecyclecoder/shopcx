-- Track whether profile linking has been checked for a ticket
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS profile_link_completed BOOLEAN NOT NULL DEFAULT false;
