-- Up to 5 KB articles per product the merchant has hand-picked as best for
-- conversion (shown first when the chat widget opens on that product's PDP).
-- Order matters — first id is shown first.
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS featured_widget_article_ids UUID[] NOT NULL DEFAULT '{}';
