-- Social scheduler: blog posts carry a clickable link. Facebook renders it as a
-- link card (POST /{page}/feed {message, link}); Instagram can't link so it's
-- ignored there (caption says "link in bio"). Nullable — only blog posts set it.
alter table public.scheduled_social_posts
  add column if not exists link_url text;
