-- organic_content — the organic social library, SEPARATE from the ads system.
-- See docs/brain/tables/organic_content.md · Phase 1 of the organic-nugget-engine spec.
--
-- Organic posting must stop depending on ad_campaigns / ad_videos. Paid-ad creative is built to
-- SELL, not to be SHARED, and ad-side changes silently change what the organic feed posts. This
-- table holds every organic asset in three formats:
--   • carousel — educational "nugget" slideshows (the ordered slides live in `slides`)
--   • reel     — the Hidden Four animated story reels (offer-free cuts; video_bucket/video_path)
--   • review   — review highlights (moved off the fake "Reviews" ad_campaigns; review_id set)
--
-- Content rules (CEO 2026-11-27): three pillars — body ("how your body really works"),
-- food_first ("natural / food-first prevention + everyday wellness"), superfoods — one shareable
-- "dinner table" takeaway per post, and for nuggets one real, accurately-described study.
--
-- Writes go ONLY through src/lib/social/organic-content.ts (service-role) — CLAUDE.md
-- "raw .from with no SDK → STOP". Enforced by scripts/_check-organic-content-sdk-compliance.ts.

create table if not exists public.organic_content (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  -- Which organic format this asset is.
  format text not null check (format in ('carousel', 'reel', 'review')),
  -- Content pillar — null for review highlights (they carry no pillar).
  pillar text check (pillar in ('body', 'food_first', 'superfoods')),

  title text,
  hook text,
  -- Ordered carousel slides: [{ headline, body, image_bucket, image_path }]. For a review, a single
  -- rendered card slide. Empty for reels (the media is the video).
  slides jsonb not null default '[]'::jsonb,
  -- The one shareable "dinner table" takeaway.
  dinner_line text,
  -- One real, accurately-described study (nuggets only).
  study_citation text,

  -- Reel media (private bucket; re-signed at publish). Null for carousel/review.
  video_bucket text,
  video_path text,

  product_id uuid references public.products(id) on delete set null,
  review_id uuid,

  -- Supervisable autonomy: nuggets land as 'draft' and a human approves before posting.
  status text not null default 'draft' check (status in ('draft', 'approved', 'retired')),
  created_by text not null default 'system',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists organic_content_ws_status_idx
  on public.organic_content (workspace_id, status, format, created_at desc);
-- Idempotency lookups: "which featured reviews already have an organic card?"
create index if not exists organic_content_review_idx
  on public.organic_content (workspace_id, review_id);

-- ── RLS — workspace-member SELECT, service-role write (mirror scheduled_social_posts) ──
alter table public.organic_content enable row level security;
drop policy if exists organic_content_service_all on public.organic_content;
create policy organic_content_service_all on public.organic_content
  for all to service_role using (true) with check (true);
drop policy if exists organic_content_select_own_workspace on public.organic_content;
create policy organic_content_select_own_workspace on public.organic_content
  for select to authenticated
  using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));

comment on table public.organic_content is
  'Organic social library, separate from ads: carousel nuggets, animated reels, review highlights. Writes via src/lib/social/organic-content.ts only. See docs/brain/tables/organic_content.md.';

-- ── Extend scheduled_social_posts for organic rows ──
-- source_kind gains 'organic' (source_ref_id → organic_content.id); keep every existing value for
-- history. Re-stated as the UNION of the live set (see
-- 20260718010000_reconcile_stale_check_constraints_to_live_values.sql) + 'organic'. Idempotent.
alter table public.scheduled_social_posts drop constraint if exists scheduled_social_posts_source_kind_check;
alter table public.scheduled_social_posts add constraint scheduled_social_posts_source_kind_check
  check (source_kind in ('avatar', 'ad_video', 'testimonial', 'resource', 'promo', 'blog', 'organic'));

-- post_type gains 'carousel' (a 2–10 slide nugget slideshow).
alter table public.scheduled_social_posts drop constraint if exists scheduled_social_posts_post_type_check;
alter table public.scheduled_social_posts add constraint scheduled_social_posts_post_type_check
  check (post_type in ('feed', 'reel', 'story', 'carousel'));
