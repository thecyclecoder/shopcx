-- creative_skeletons: deliberate per-product competitor linkage (base-layer refactor, CEO 2026-07-12).
--
-- WHY: the imitate→innovate loop is per-PRODUCT — each product imitates the competitors WE deliberately
-- chose for it (competitors.product_id). But creative_skeletons carried no product/competitor link, so the
-- library was a workspace-wide soup and Dahlia's getProvenCompetitorAngles matched by a coffee/weight niche
-- substring instead of the product's real competitor set. These two columns let the scout TAG each analyzed
-- ad with the competitor + product it was pulled for, so imitate reads exactly that product's shelf.
--
-- The old workspace-wide creative-finder sweep (CATEGORY_SEEDS + all-competitor pulls, no product context)
-- produced the 473 rows currently in the table — none of them product-tagged and none re-derivable. We go
-- FULLY DELIBERATE: drop those stale rows so the new per-product scout repopulates only what a product's own
-- competitor list yields. HARD delete (not archive) because the pattern-matrix / promotion scans read
-- source='adlibrary' with no status filter — an archived row would still be seen.

alter table public.creative_skeletons
  add column if not exists competitor_id uuid references public.competitors(id) on delete set null,
  add column if not exists product_id    uuid references public.products(id)    on delete set null;

create index if not exists creative_skeletons_product_id_idx    on public.creative_skeletons(product_id);
create index if not exists creative_skeletons_competitor_id_idx on public.creative_skeletons(competitor_id);

-- Clear the pre-refactor library (all rows predate product tagging → product_id is null for every one).
-- The new per-product scout (ads/creative-scout.sweep) repopulates from each product's approved competitors.
delete from public.creative_skeletons where product_id is null;
