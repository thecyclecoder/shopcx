-- Atomic increment for consecutive_skips (avoids race conditions)
CREATE OR REPLACE FUNCTION public.increment_consecutive_skips(p_sub_id UUID)
RETURNS INTEGER
LANGUAGE sql
AS $$
  UPDATE public.subscriptions
  SET consecutive_skips = consecutive_skips + 1
  WHERE id = p_sub_id
  RETURNING consecutive_skips;
$$;
