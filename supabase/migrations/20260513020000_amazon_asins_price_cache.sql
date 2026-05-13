-- Cache the current Amazon prices on amazon_asins so the storefront
-- doesn't need to round-trip Amazon SP-API on every page render. The
-- GET /api/workspaces/[id]/amazon/pricing route already fetches these
-- live; we now write them back here after the fetch + on POST so the
-- storefront price-table banner can join products → amazon_asins and
-- compute "Save $X by buying direct".

ALTER TABLE public.amazon_asins
  ADD COLUMN IF NOT EXISTS current_price_cents INTEGER,
  ADD COLUMN IF NOT EXISTS list_price_cents INTEGER,
  ADD COLUMN IF NOT EXISTS sale_price_cents INTEGER,
  ADD COLUMN IF NOT EXISTS price_fetched_at TIMESTAMPTZ;
