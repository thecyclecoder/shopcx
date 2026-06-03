-- Ad tool — make avatar face generation async (Inngest, not a blocking API route).
--
-- Image generation takes 30-180s — longer than the Vercel function budget. So the
-- candidates API now inserts a row in status='generating' (no image yet) and
-- fires an Inngest event; the durable function generates + polls + fills in
-- storage_path + flips status='available'. The UI polls until done. That means
-- storage_path must be nullable (set on completion), plus a failure channel.

ALTER TABLE public.ad_avatar_candidates ALTER COLUMN storage_path DROP NOT NULL;
ALTER TABLE public.ad_avatar_candidates ADD COLUMN IF NOT EXISTS error TEXT;

COMMENT ON COLUMN public.ad_avatar_candidates.status IS
  'generating | available | used | discarded | failed. Rows start generating (storage_path NULL) and flip to available when the Inngest face job uploads the image.';
