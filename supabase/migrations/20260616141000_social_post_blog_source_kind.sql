-- Allow source_kind='blog' (always-on daily blog slot). The original check
-- predates the blog/promo kinds; recreate it with the full current set.
alter table public.scheduled_social_posts
  drop constraint if exists scheduled_social_posts_source_kind_check;
alter table public.scheduled_social_posts
  add constraint scheduled_social_posts_source_kind_check
  check (source_kind = any (array['avatar','ad_video','testimonial','resource','promo','blog']));
