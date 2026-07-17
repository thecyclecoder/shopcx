-- winners-flow Phase 1 — advertiser resolution. Store the VERIFIED Meta advertiser identity per competitor
-- so the winners scan ([[/api/winners/advertiser/{pageId}]]) targets the exact page (resolve once, scan by
-- id forever). Populated by resolveAdvertiser (src/lib/adlibrary-winners.ts): brand → /api/advertisers/search
-- (highest-likes name-matching candidate — NOT blind best_match, which mis-picked "Mud Wtr Wellness" over the
-- real 124K-like "MUD\WTR"), with a DOMAIN fallback (/api/search?domain=) for un-nameable brands (Beam →
-- shopbeam.com, Wellah → wellah.com). A competitor that resolves to neither a page nor a domain hit is a
-- RELIABLE bad seed (unlike the old flaky 0-ads heuristic — /api/search only returns recent ads).
alter table public.competitors
  add column if not exists meta_page_id       text,        -- the resolved Meta advertiser Page ID (winners scan target)
  add column if not exists meta_resolved_name text,        -- the page name we matched (founder verifies)
  add column if not exists meta_likes         bigint,      -- the page's like count (brand-size sanity signal)
  add column if not exists meta_resolved_via  text,        -- 'name' | 'domain' | null (how it resolved)
  add column if not exists meta_resolved_at   timestamptz; -- last resolve attempt

comment on column public.competitors.meta_page_id is
  'Resolved Meta advertiser Page ID for the winners scan (POST /api/winners/advertiser/{pageId}). Null = '
  'unresolved (bad/ambiguous seed) — see resolveAdvertiser in src/lib/adlibrary-winners.ts. (winners-flow P1)';
