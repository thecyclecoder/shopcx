-- Drop the deprecated ShopGrowth-era `product_intelligence` blob table. Its structured successor is the
-- product_* surface (product_ingredient_research / product_benefit_selections / product_ad_angles /
-- product_page_content / product_review_analysis / product_media), read via src/lib/product-intelligence.ts.
-- The last row (source='shopgrowth', Amazing Coffee) was deleted first; no live code reads the table.
-- CASCADE severs the dead FK from the already-empty, reader-less macro_audit_jobs (removed macro-audit
-- feature) without dropping that table.
DROP TABLE IF EXISTS public.product_intelligence CASCADE;  -- reversible: deprecation-window elapsed — the ShopGrowth-era blob table's last row (source='shopgrowth', Amazing Coffee) was deleted first, no live code reads it, and its structured successor (the product_* surface) has been live for months; CASCADE only severs the dead FK from the reader-less macro_audit_jobs (already-removed macro-audit feature).
