ALTER TABLE public.sync_jobs
  ADD COLUMN current_month INTEGER DEFAULT 0,
  ADD COLUMN total_months INTEGER DEFAULT 36;
