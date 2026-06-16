-- "N reasons why" listicle lander variant.
--
-- Adds a `reasons` array to advertorial_pages so the editorial top can be a
-- numbered listicle (variant='reasons') — the scent-match for the ingredient-
-- breakdown ad ("here's exactly what's inside / why it works"). Each reason is
-- { heading, body }; the headline/dek/hero columns are reused as-is. `variant`
-- is free text already, so no enum change is needed.
alter table public.advertorial_pages
  add column if not exists reasons jsonb not null default '[]';
