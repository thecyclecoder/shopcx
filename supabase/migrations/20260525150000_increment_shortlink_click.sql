-- The shortlink redirect handler was doing `click_count: shortlink.click_count + 1`
-- read-modify-write — fine at low traffic, but every concurrent click on the
-- same shortlink during a campaign send took a row lock on the same row,
-- serializing under load. With 1500+ click UPDATEs in 5 min during the MDW
-- active_sub send, this becomes the next hot-row to lock the pool.
--
-- Replace with an atomic SQL increment via RPC. The handler still passes
-- last_clicked_at + the "first_clicked_at on first click" guard.

CREATE OR REPLACE FUNCTION public.increment_shortlink_click(
  p_shortlink_id UUID,
  p_clicked_at TIMESTAMPTZ DEFAULT now()
)
RETURNS VOID
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.marketing_shortlinks
  SET
    click_count = click_count + 1,
    last_clicked_at = p_clicked_at,
    first_clicked_at = COALESCE(first_clicked_at, p_clicked_at)
  WHERE id = p_shortlink_id;
$$;

GRANT EXECUTE ON FUNCTION public.increment_shortlink_click(UUID, TIMESTAMPTZ) TO service_role;
