-- Auto-blog: author bylines (E-E-A-T) + a portrait social variant of the hero.
-- See specs/auto-blog-generation.md.
--
--  author_slug       — which persona wrote the post (registry in src/lib/blog/authors.ts).
--  social_image_url  — a 4:5 (1080x1350) version of the main image, stored but NOT
--                      shown on the blog. The organic social scheduler prefers this
--                      when posting a blog resource to IG/FB; falls back to
--                      featured_image_url for older posts that don't have one.
ALTER TABLE public.posts ADD COLUMN IF NOT EXISTS author_slug      TEXT;
ALTER TABLE public.posts ADD COLUMN IF NOT EXISTS social_image_url TEXT;
