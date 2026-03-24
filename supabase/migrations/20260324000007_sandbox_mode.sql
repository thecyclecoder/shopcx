ALTER TABLE public.workspaces
  ADD COLUMN sandbox_mode BOOLEAN NOT NULL DEFAULT true;
