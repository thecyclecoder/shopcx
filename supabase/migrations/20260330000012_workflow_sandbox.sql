-- Per-workflow sandbox mode
ALTER TABLE public.workflows ADD COLUMN IF NOT EXISTS sandbox_mode BOOLEAN NOT NULL DEFAULT false;
