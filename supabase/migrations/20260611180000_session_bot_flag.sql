-- Bot/crawler exclusion for the storefront funnel.
--
-- Meta's ad-review crawlers hit storefront PDPs from Facebook data centers
-- (Prineville, Luleå, Clonee, Forest City, Altoona, Fort Worth…) on a scripted
-- ~30s budget, spoofing real mobile browser UAs and auto-scrolling the page —
-- so UA, engagement, and city heuristics all fail or misfire. The one
-- false-positive-safe signal is network origin: real shoppers come from
-- residential/mobile ISPs, crawlers from datacenter/Meta (AS32934) networks.
--
-- /api/pixel classifies the request IP at ingestion (src/lib/datacenter-ip.ts)
-- and stores ONLY this boolean — never the raw IP, preserving the no-PII stance.
-- The funnel excludes is_bot the same way it excludes is_internal.

alter table public.storefront_sessions
  add column if not exists is_bot boolean not null default false;

create index if not exists idx_storefront_sessions_is_bot
  on public.storefront_sessions (workspace_id) where is_bot;
