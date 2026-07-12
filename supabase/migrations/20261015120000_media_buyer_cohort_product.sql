-- media_buyer_test_cohorts — Product dimension on the cohort
-- (media-buyer-product-scoped-test-rail Phase 1).
--
-- Additive: adds a nullable public.products FK so a shared Meta ad account
-- can hold ONE cohort PER product. Replaces the (workspace_id, meta_ad_account_id)
-- active-cohort uniqueness with (workspace_id, meta_ad_account_id, product_id) so
-- each product gets its own adset + ceiling. The null-product row stays the
-- workspace/account default (Superfood Tabs unaffected).
--
-- Fully idempotent (re-run = no-op): add column if not exists + drop index if
-- exists + create unique index if not exists.

alter table public.media_buyer_test_cohorts
  add column if not exists product_id uuid references public.products(id);

-- Replace the old (workspace, account) uniqueness with (workspace, account, product).
drop index if exists public.media_buyer_test_cohorts_ws_account_active_key;

create unique index if not exists media_buyer_test_cohorts_ws_account_product_active_key
  on public.media_buyer_test_cohorts (
    workspace_id,
    coalesce(meta_ad_account_id::text, ''),
    coalesce(product_id::text, '')
  )
  where is_active = true;
