-- Temporary helper to truncate sync data (will be removed)
CREATE OR REPLACE FUNCTION public.reset_sync_data()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
  TRUNCATE public.orders, public.customers, public.sync_jobs CASCADE;
$$;
