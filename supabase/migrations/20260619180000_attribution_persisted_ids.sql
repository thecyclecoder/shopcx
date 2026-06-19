-- Storefront Iteration Engine — Phase 2b (attribution hardening).
--
-- Persist the resolved lander/campaign identity on the session (at pixel time)
-- and the order (at checkout) so attribution no longer depends on re-parsing
-- `?angle={slug}` out of landing_url, and survives cross-session conversion.
--
-- Both columns are nullable + ON DELETE SET NULL: a session/order can predate a
-- lander (or land off a non-advertorial URL), and deleting an advertorial_page /
-- ad_campaign must never cascade-delete a session or an order.
--
-- The attribution computation (src/lib/meta/attribution.ts) prefers these columns
-- and falls back to the Phase 2 URL-parse join when null, so coverage migrates
-- upward as the columns populate on new traffic. See
-- docs/brain/specs/storefront-iteration-engine.md (Phase 2b).

alter table public.storefront_sessions
  add column if not exists advertorial_page_id uuid
    references public.advertorial_pages(id) on delete set null,
  add column if not exists ad_campaign_id uuid
    references public.ad_campaigns(id) on delete set null;

alter table public.orders
  add column if not exists advertorial_page_id uuid
    references public.advertorial_pages(id) on delete set null,
  add column if not exists ad_campaign_id uuid
    references public.ad_campaigns(id) on delete set null;

-- Attribution rollups filter/group by these ids; partial indexes keep them cheap
-- (the columns are null for the bulk of non-lander traffic).
create index if not exists storefront_sessions_advertorial_page_idx
  on public.storefront_sessions (advertorial_page_id)
  where advertorial_page_id is not null;
create index if not exists storefront_sessions_ad_campaign_idx
  on public.storefront_sessions (ad_campaign_id)
  where ad_campaign_id is not null;
create index if not exists orders_advertorial_page_idx
  on public.orders (advertorial_page_id)
  where advertorial_page_id is not null;
create index if not exists orders_ad_campaign_idx
  on public.orders (ad_campaign_id)
  where ad_campaign_id is not null;
