-- Track which month the sync completed up to for resume capability
ALTER TABLE public.sync_jobs
  ADD COLUMN last_completed_month INTEGER DEFAULT 0;
