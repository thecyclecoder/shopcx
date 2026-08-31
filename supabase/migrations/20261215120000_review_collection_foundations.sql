-- Review collection foundations, Phase 1 — schema for the in-house reviews program.
--
-- Nothing has collected a product review since 2026-07-01, when the Klaviyo
-- review-request flow died with that vendor. This migration lands the SCHEMA
-- the rebuilt program will write into. Additive + idempotent — no DROP; the
-- repo's reversible-by-default rail (scripts/_check-no-hard-destructive-migrations.ts)
-- runs in predeploy.
--
-- Four independent pieces, one file so they land in one commit:
--   1. products.reviewable           — bool, default true. Add-ons (Shipping
--                                       Protection, Mystery Item, the three
--                                       '(Free Gift)' duplicates) are flipped
--                                       to false by scripts/_backfill-products-
--                                       reviewable-add-ons.ts so the review
--                                       journey never asks about them.
--   2. journey_sessions.product_id   — nullable uuid → products(id). The other
--                                       twelve journeys don't use it; the review
--                                       journey is product-specific.
--   3. product_reviews.attribute_scores jsonb — per-product slider answers.
--                                       jsonb rather than columns because the
--                                       question set varies per product (Flavor
--                                       is meaningless for the Tumbler / Mixer
--                                       / Mug).
--   4. review_requests               — one row per ask. The ladder's memory:
--                                       which angle a customer already received,
--                                       which channel, when it was sent + nudged,
--                                       and the outcome. RLS enabled per
--                                       scripts/_check-rls-on-new-tables.ts.
--
-- Brain pages: docs/brain/tables/review_requests.md (new) + updates to
-- products.md · journey_sessions.md · product_reviews.md in the same PR per the
-- CLAUDE.md "code without a brain page is incomplete" hard rule.
--
-- Spec: docs/brain/specs/review-collection-foundations.md Phase 1.

-- 1. products.reviewable ─────────────────────────────────────────────────────
alter table public.products
  add column if not exists reviewable boolean not null default true;

comment on column public.products.reviewable is
  'Whether this product may be asked about in the review-collection journey. '
  'False for add-ons the customer did not choose to buy on merit (Shipping '
  'Protection, Mystery Item, ''(Free Gift)'' duplicates). Backfilled by '
  'scripts/_backfill-products-reviewable-add-ons.ts.';

-- 2. journey_sessions.product_id ─────────────────────────────────────────────
alter table public.journey_sessions
  add column if not exists product_id uuid references public.products(id);

comment on column public.journey_sessions.product_id is
  'Product this session asks about. Nullable — only the product-review journey '
  'sets it; the other twelve journeys leave it null.';

create index if not exists journey_sessions_product_id_idx
  on public.journey_sessions (product_id) where product_id is not null;

-- 3. product_reviews.attribute_scores ────────────────────────────────────────
alter table public.product_reviews
  add column if not exists attribute_scores jsonb;

comment on column public.product_reviews.attribute_scores is
  'Slider answers from the product-review journey — e.g. '
  '{"convenience":5,"effectiveness":4,"flavor":5,"expectation":"exceeded"}. '
  'jsonb because the question set is per-product (Flavor is skipped for the '
  'Tumbler / Mixer / Mug). Null for reviews collected before the in-house '
  'program (all pre-2026-07-01 rows).';

-- 4. review_requests ────────────────────────────────────────────────────────
create table if not exists public.review_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  -- The journey session this ask points at. Nullable because the row is
  -- written when the ask is sent; the session materializes when the customer
  -- clicks the link. A never-clicked ask stays journey_session_id IS NULL.
  journey_session_id uuid references public.journey_sessions(id) on delete set null,
  -- Set when a 1-3 star submission routes to CS as a ticket instead of
  -- publishing. Null for the happy path.
  ticket_id uuid references public.tickets(id) on delete set null,
  -- Which angle the ask used — 'first-touch' / 'nudge' / a product-specific
  -- variant. Free-text so the ladder can add new angles without a migration;
  -- the ladder itself picks from a fixed list (config in the journey
  -- definition, not this table).
  angle text not null,
  -- 'email' | 'sms' — text so the ladder can add channels (mini-site, in-app,
  -- ...) without a migration.
  channel text not null,
  sent_at timestamptz not null default now(),
  -- One nudge per ask maximum. Null until the ladder sends its follow-up.
  nudged_at timestamptz,
  -- 'sent' → 'clicked' → 'submitted' | 'routed_to_cs' | 'expired'. Text so the
  -- ladder can add outcomes without a migration; readers probe actual values
  -- (CLAUDE.md § "Database is the spec").
  outcome text not null default 'sent',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.review_requests is
  'One row per review ask. The ladder''s memory — which angle a customer '
  'already received, which channel, when it was sent + nudged, and the '
  'outcome. A never-clicked row stays journey_session_id IS NULL; a '
  '1-3 star submission carries ticket_id.';

-- The ladder never asks the same customer about the same product twice in the
-- same window; readers filter by (customer_id, product_id) — index accordingly.
create index if not exists review_requests_customer_product_idx
  on public.review_requests (workspace_id, customer_id, product_id, sent_at desc);

create index if not exists review_requests_outcome_idx
  on public.review_requests (workspace_id, outcome, sent_at desc);

create index if not exists review_requests_journey_session_idx
  on public.review_requests (journey_session_id) where journey_session_id is not null;

create index if not exists review_requests_ticket_id_idx
  on public.review_requests (ticket_id) where ticket_id is not null;

create or replace function public.review_requests_touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists review_requests_touch_updated_at on public.review_requests;
create trigger review_requests_touch_updated_at
  before update on public.review_requests
  for each row execute function public.review_requests_touch_updated_at();

alter table public.review_requests enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'review_requests'
      and policyname = 'review_requests_member_read'
  ) then
    create policy review_requests_member_read on public.review_requests for select to authenticated
      using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
  end if;
  if not exists (
    select 1 from pg_policies
    where tablename = 'review_requests'
      and policyname = 'review_requests_service_role'
  ) then
    create policy review_requests_service_role on public.review_requests for all
      using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
end $$;
