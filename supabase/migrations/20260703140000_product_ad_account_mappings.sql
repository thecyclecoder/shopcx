-- product_ad_account_mappings — the persistent linked-group → Meta ad-account(s) map behind
-- AcqROAS (docs/brain/specs/growth-acquisition-roas-spine.md Phase 3). Removes the hardcode
-- (coffee → 'Amazing Coffee & Creamer' meta_account_id 'd6d619a5').
--
-- AcqROAS(group, window) = (on-site + Amazon non-renewal revenue) / Σ mapped-account Meta spend.
-- One row per (group, ad account). A group can map to several accounts; an account can serve
-- several groups (the 'Amazing Coffee & Creamer' account covers BOTH coffee and creamer).
--
-- Per-(group,account) `spend_share` resolves the multi-product-account nuance (spec Phase 3):
--   - is_shared_account = true, spend_share = 1.0  →  charge ALL the account's spend to this group;
--     the denominator is inflated, so AcqROAS is a CONSERVATIVE FLOOR (flagged on the report).
--     This is the coffee default — the account also serves creamer but we have no precise split yet.
--   - spend_share < 1.0  →  attribute only that fraction of the account's spend to this group
--     (use once a real split is known). Σ of an account's shares across its groups should be ≤ 1.
--
-- The two versioned attribution assumptions (spec § 'Explicit, versioned assumptions') live here too,
-- per group — configurable, surfaced on the report, never hardcoded:
--   - credit_amazon_to_meta   : include the Amazon non-renewal halo in the numerator (Meta is the only
--                               paid acquisition channel, so Amazon sales are Meta-derivative). Default true.
--   - count_all_non_renewal   : count EVERY non-renewal on-site sale, not just utm_source=meta ones
--                               (non-utm sales are still Meta-derivative). Default true.
--
-- Workspace-scoped. RLS mirrors director_activity: any authenticated user reads; service role writes.

create table if not exists public.product_ad_account_mappings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  group_id uuid not null references public.product_link_groups(id) on delete cascade,
  meta_ad_account_id uuid not null references public.meta_ad_accounts(id) on delete cascade,
  -- fraction of the account's Meta spend attributed to this group (0 < share ≤ 1).
  spend_share numeric not null default 1.0 check (spend_share > 0 and spend_share <= 1),
  -- true when the account serves more than this one group (with share 1.0 → AcqROAS is a floor).
  is_shared_account boolean not null default false,
  -- versioned attribution assumptions (per group), surfaced on the report.
  credit_amazon_to_meta boolean not null default true,
  count_all_non_renewal boolean not null default true,
  -- plain-text "why" for this mapping / share choice.
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One mapping per (group, account); upsert target.
create unique index if not exists product_ad_account_mappings_group_account_uniq
  on public.product_ad_account_mappings (group_id, meta_ad_account_id);
-- Per-workspace and per-account audit slices.
create index if not exists product_ad_account_mappings_workspace_idx
  on public.product_ad_account_mappings (workspace_id);
create index if not exists product_ad_account_mappings_account_idx
  on public.product_ad_account_mappings (meta_ad_account_id);

alter table public.product_ad_account_mappings enable row level security;
drop policy if exists product_ad_account_mappings_select on public.product_ad_account_mappings;
create policy product_ad_account_mappings_select on public.product_ad_account_mappings
  for select to authenticated using (auth.uid() is not null);
drop policy if exists product_ad_account_mappings_service on public.product_ad_account_mappings;
create policy product_ad_account_mappings_service on public.product_ad_account_mappings
  for all to service_role using (true) with check (true);
