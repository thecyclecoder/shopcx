-- Shared competitor shelf — one product may imitate from another product's scouted competitor ads.
--
-- CEO 2026-08-25. Amazing Coffee K-Cups is the same coffee in a pod, so the coffee competitors
-- (mudwtr, ryze, foursigmatic, bulletproof, …) legitimately serve it. But `creative_skeletons.product_id`
-- is "the deliberate imitate link" and Dahlia's `getProvenCompetitorAngles` filters on it, so K-Cups
-- would imitate from an EMPTY shelf.
--
-- Copying the competitor rows does not fix it: the AdLibrary freshness ledger is keyed on
-- (workspace_id, keyword) and the sweep walks products SEQUENTIALLY, so whichever product sweeps a
-- shared keyword first stamps the ledger and the other is skipped as fresh — permanently starving
-- whichever product happens to sort second, while storing duplicate competitor rows for no benefit.
--
-- So instead of duplicating data, we point at it. DIRECTED on purpose: K-Cups reads Amazing Coffee's
-- shelf, NOT the reverse — Coffee has its own rich shelf and must not be silently widened.
alter table public.products
  add column if not exists competitor_shelf_source_id uuid
    references public.products (id) on delete set null;

comment on column public.products.competitor_shelf_source_id is
  'Another product whose scouted competitor shelf (creative_skeletons.product_id) this product may ALSO imitate from. Directed + resolved ONE HOP only (no chains, no cycles) by resolveShelfProductIds in src/lib/ads/creative-sourcing.ts. NULL = imitate only from own shelf (the default for every product). Does NOT affect AdLibrary sweep seeds — those stay strictly product-scoped so a shared shelf never doubles quota spend.';

-- A product pointing at itself is a no-op that would only confuse the resolver; forbid it outright.
alter table public.products
  drop constraint if exists products_competitor_shelf_source_not_self;
alter table public.products
  add constraint products_competitor_shelf_source_not_self
    check (competitor_shelf_source_id is null or competitor_shelf_source_id <> id);
