-- Drop the unused advertorial_pages.sticky_nav column.
-- The sticky jump-nav (StickyJumpNav) uses hardcoded labels ("Ingredients" /
-- "See pricing"), per the resolved spec open-question. The column was never
-- written or read — remove the cruft.
alter table public.advertorial_pages drop column if exists sticky_nav;
