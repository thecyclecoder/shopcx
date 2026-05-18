-- ─────────────────────────────────────────────────────────────────
-- PHASE 12 — RETIRE the `social_comments` ticket channel.
--
-- ⚠️  DO NOT APPLY THIS MIGRATION UNTIL:
--     1. Phase 11 (`scripts/migrate-social-comments-tickets.ts`) has
--        been run with `--confirm` against production.
--     2. A SELECT verifying zero remaining unarchived tickets with
--        `channel = 'social_comments'` returns 0.
--     3. The deploy that ships the new webhook routing has been live
--        long enough that no in-flight delivery could still create a
--        social_comments-channel ticket.
--
-- To activate this migration, rename the file:
--     mv supabase/migrations/_PENDING_meta_comments_retire_channel.sql \
--        supabase/migrations/<timestamp>_meta_comments_retire_channel.sql
--
-- ─────────────────────────────────────────────────────────────────

-- Tickets — drop social_comments from the allowed channels.
ALTER TABLE public.tickets DROP CONSTRAINT IF EXISTS tickets_channel_check;
ALTER TABLE public.tickets ADD CONSTRAINT tickets_channel_check CHECK (
  channel IN ('email','chat','meta_dm','sms','help_center','portal')
);

-- AI channel config — same.
ALTER TABLE public.ai_channel_config DROP CONSTRAINT IF EXISTS ai_channel_config_channel_check;
ALTER TABLE public.ai_channel_config ADD CONSTRAINT ai_channel_config_channel_check CHECK (
  channel IN ('email', 'chat', 'sms', 'meta_dm', 'phone', 'help_center', 'portal')
);

-- Defensive sweep — if any social_comments rows snuck back in
-- between Phase 11 and this migration, archive them so the
-- constraint can be applied. Better safe than fail-deploy.
UPDATE public.tickets
SET status = 'archived',
    tags = (
      SELECT array_agg(DISTINCT t)
      FROM unnest(coalesce(tags, '{}'::text[]) || array['migrated_to_social_comments']) AS t
    )
WHERE channel = 'social_comments';

-- After this migration applies cleanly, the legacy workspaces.meta_*
-- columns can also be considered for retirement in a follow-up:
--   workspaces.meta_page_id
--   workspaces.meta_page_access_token_encrypted
--   workspaces.meta_instagram_id
--   workspaces.meta_webhook_verify_token
--   workspaces.meta_page_name
-- They're now mirrored on meta_pages, but DM ingestion still reads
-- the legacy columns as a fallback. Retire those reads first.
