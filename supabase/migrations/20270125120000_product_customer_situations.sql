-- product_customer_situations — the real life-situations our customers were in, mined from the
-- best-reviews set, as a verifiable, compliance-checked dataset (docs/brain/specs/ai-shopping-agent-mcp.md
-- Phase 1). One source shared by the AI shopping-agent MCP server (find_products_for_situation) and the
-- PDP AI-answers (AEO) work — both read the SAME rows so a situation can't drift between surfaces.
--
-- North-star / compliance: each row (and each nested quote) carries its own `compliance_ok` flag.
-- Incentivized/coupon reviews and pounds-lost / disease-term quotes are STORED (for audit) but NEVER
-- surfaced to shoppers — readers that render text filter to compliance_ok=true via the SDK
-- (src/lib/customer-situations.ts). Writes go only through that SDK (service_role) — enforced by
-- scripts/_check-customer-situations-sdk-compliance.ts, mirroring the competitors chokepoint.
--
-- Joins are on the internal product UUID (never shopify_*_id — Shopify is being sunset). No
-- customer_id column, so no Sonnet data tool is required.

create table if not exists public.product_customer_situations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  -- Stable per-product key for the situation (e.g. 'tried-everything', 'coffee-swap').
  slug text not null,
  -- The situation in plain structure/function language ("Tried everything before and nothing stuck").
  situation text not null,
  who text,
  goal text,
  noticed text,
  timeframe text,
  -- The first COMPLIANT verbatim quote for this situation (convenience mirror of quotes[].verbatim_phrase).
  verbatim_phrase text,
  -- The source review UUIDs this situation was mined from (internal product_reviews ids).
  review_ids uuid[] not null default '{}',
  -- Array of { review_id, reviewer, rating, verified_purchase, featured, verbatim_phrase,
  --            compliance_ok, compliance_note }. Non-compliant quotes are kept for audit, never surfaced.
  quotes jsonb not null default '[]'::jsonb,
  -- Situation-level compliance gate. Default false — a row is surfaceable ONLY when explicitly true.
  compliance_ok boolean not null default false,
  compliance_note text,
  -- Provenance of the row, e.g. 'seed:aeo-2026-11-23'.
  source text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One situation per (workspace, product, slug) — the upsert key.
  constraint product_customer_situations_slug_uniq unique (workspace_id, product_id, slug)
);

create index if not exists product_customer_situations_ws_product_idx
  on public.product_customer_situations (workspace_id, product_id);
create index if not exists product_customer_situations_compliant_idx
  on public.product_customer_situations (workspace_id, product_id, compliance_ok, active);

-- ── RLS — workspace-member SELECT, service-role write (mirror storefront_levers / competitors) ──
alter table public.product_customer_situations enable row level security;
drop policy if exists product_customer_situations_select on public.product_customer_situations;
create policy product_customer_situations_select on public.product_customer_situations
  for select to authenticated using (auth.uid() is not null);
drop policy if exists product_customer_situations_service on public.product_customer_situations;
create policy product_customer_situations_service on public.product_customer_situations
  for all to service_role using (true) with check (true);

comment on table public.product_customer_situations is
  'Compliance-checked customer life-situations mined from the best-reviews set; shared source for the AI shopping-agent MCP server and PDP AEO. Writes via src/lib/customer-situations.ts only. See docs/brain/tables/product_customer_situations.md.';
