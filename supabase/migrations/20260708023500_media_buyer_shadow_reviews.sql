-- media-buyer-shadow-mode Phase 3 — Media Buyer shadow reviews.
--
-- The human-in-the-loop surface behind the CEO's "shadow / read-only before armed"
-- guardrail. Every Media Buyer pass on a `mode='shadow'` policy emits one
-- `<verb>_shadow` [[director_activity]] row per plan action (Phase 2); this table
-- lets the Growth reviewer concur / dissent / defer per action so the flip to
-- `armed` (spec `media-buyer-armed-flip-surface`) has evidence, not vibes.
--
-- One row per Media Buyer shadow action (director_activity_id UNIQUE) — idempotent
-- review. Writes go through the service-role POST route
-- [[../../src/app/api/growth/media-buyer/shadow-reviews/route.ts]]; RLS: workspace-
-- member SELECT, service-role write (mirrors [[../../docs/brain/tables/media_buyer_action_grades.md]]).
--
-- The dashboard tile at `/dashboard/marketing/ads` reads via the sibling GET
-- endpoint to render every `_shadow` director_activity row that lacks a review.

create table if not exists public.media_buyer_shadow_reviews (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  -- The Media Buyer shadow action this review scores. UNIQUE = idempotent review —
  -- a second POST for the same action UPDATES in place, never inserts a duplicate.
  -- ON DELETE CASCADE so a deleted director_activity row also drops its review.
  director_activity_id uuid not null unique references public.director_activity(id) on delete cascade,

  -- Reviewer's verdict:
  --   concur    = "if this were armed, I'd let the executor apply it" — evidence for the flip.
  --   dissent   = "the plan is wrong — DO NOT arm this policy version" — evidence against.
  --   undecided = "I looked but the signal is thin — recheck next pass" — the neutral park state.
  verdict text not null check (verdict in ('concur', 'dissent', 'undecided')),
  rationale text,

  -- The workspace member who reviewed. Nullable — an agent-driven auto-concur path can leave it null,
  -- but the human-facing route requires a signed-in user (enforced at the route layer).
  reviewer uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz not null default now(),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Feed by workspace, most-recent review first — the Growth dashboard tile reads this.
create index if not exists media_buyer_shadow_reviews_ws_idx
  on public.media_buyer_shadow_reviews (workspace_id, created_at desc);

-- Auto-bump updated_at on any UPDATE so a re-review carries a fresh timestamp.
create or replace function public.media_buyer_shadow_reviews_touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists media_buyer_shadow_reviews_touch_updated_at on public.media_buyer_shadow_reviews;
create trigger media_buyer_shadow_reviews_touch_updated_at
  before update on public.media_buyer_shadow_reviews
  for each row execute function public.media_buyer_shadow_reviews_touch_updated_at();

alter table public.media_buyer_shadow_reviews enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'media_buyer_shadow_reviews' and policyname = 'media_buyer_shadow_reviews_select') then
    create policy media_buyer_shadow_reviews_select on public.media_buyer_shadow_reviews for select
      using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'media_buyer_shadow_reviews' and policyname = 'media_buyer_shadow_reviews_service') then
    create policy media_buyer_shadow_reviews_service on public.media_buyer_shadow_reviews for all
      using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
end $$;
