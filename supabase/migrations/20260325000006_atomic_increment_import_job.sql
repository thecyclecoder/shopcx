-- Atomic increment for import_jobs progress tracking (fan-out safe)
CREATE OR REPLACE FUNCTION public.atomic_increment_import_job(
  p_job_id UUID,
  p_processed_records INTEGER DEFAULT 0,
  p_completed_chunks INTEGER DEFAULT 0,
  p_finalize_completed INTEGER DEFAULT 0
)
RETURNS TABLE(
  completed_chunks INTEGER,
  total_chunks INTEGER,
  finalize_completed INTEGER,
  finalize_total INTEGER
)
LANGUAGE sql
AS $$
  UPDATE public.import_jobs
  SET
    processed_records = processed_records + p_processed_records,
    completed_chunks = completed_chunks + p_completed_chunks,
    finalize_completed = finalize_completed + p_finalize_completed
  WHERE id = p_job_id
  RETURNING completed_chunks, total_chunks, finalize_completed, finalize_total;
$$;
