-- ─────────────────────────────────────────────────────────────────
-- Meta Comments Moderation — Phase 1 schema
--
-- Five tables that together replace the social_comments-channel ticket
-- pathway with a dedicated moderation surface:
--
--   meta_pages              one row per FB Page / IG Business account.
--                           Per-page access token (encrypted) so a
--                           workspace can connect multiple pages, and
--                           per-page page_type (brand|creator) drives
--                           default moderation policy.
--   social_comments         the moderation queue itself. One row per
--                           Meta comment that fires the webhook.
--   social_comment_replies  nested reply thread per comment (inbound
--                           from users + outbound replies we send).
--   banned_meta_users       workspace-wide ban list. Banning a user
--                           hides existing + auto-hides future comments.
--   meta_post_cache         denormalized post metadata (URL, image,
--                           caption, is_ad, matched product) so the
--                           comment views don't round-trip to Graph API
--                           on every render.
--
-- Backfills any workspace already connected via the legacy
-- workspaces.meta_page_* columns into a meta_pages row. The legacy
-- columns stay in place for the duration of Phase 1 and get retired
-- alongside the social_comments ticket-channel cleanup in a later
-- migration.
--
-- See META-COMMENTS-SPEC.md for the architecture overview.
-- ─────────────────────────────────────────────────────────────────


-- ── meta_pages ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.meta_pages (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id                  UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,

  -- 'facebook' = FB Page, 'instagram' = IG Business account.
  -- Both share the same Graph API surface so we keep them in one table.
  platform                      TEXT NOT NULL CHECK (platform IN ('facebook', 'instagram')),

  -- The Meta-side identifier (FB Page ID or IG Business Account ID).
  -- Always a string — Meta IDs are numeric but large enough to overflow
  -- JS numbers, so everywhere in the codebase we keep them as TEXT.
  meta_page_id                  TEXT NOT NULL,
  meta_page_name                TEXT,

  -- For FB Pages connected to an IG Business account, we cache the IG
  -- ID here as a convenience — saves a Graph round-trip when the agent
  -- wants to deep-link to Instagram.
  meta_instagram_id             TEXT,

  -- 'brand'   = our own pages (Superfoods Company FB + IG). Default
  --             policy: moderate ad AND organic comments.
  -- 'creator' = creator / influencer pages we run ads with. Default
  --             policy: moderate ad comments, leave organic alone
  --             (their followers expect their voice, not ours).
  page_type                     TEXT NOT NULL DEFAULT 'brand'
                                CHECK (page_type IN ('brand', 'creator')),

  ai_moderate_ad_comments       BOOLEAN NOT NULL DEFAULT true,
  ai_moderate_organic_comments  BOOLEAN NOT NULL DEFAULT true,

  -- Long-lived Page Access Token. AES-256-GCM encrypted, same pattern
  -- as workspaces.meta_page_access_token_encrypted today.
  access_token_encrypted        TEXT NOT NULL,

  -- Per-page webhook verify token. Today there's one per workspace on
  -- workspaces.meta_webhook_verify_token; once multi-page lands the
  -- callback resolves verify against this column instead.
  webhook_verify_token          TEXT,

  is_active                     BOOLEAN NOT NULL DEFAULT true,
  connected_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at                TIMESTAMPTZ,

  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT meta_pages_workspace_page_key
    UNIQUE (workspace_id, meta_page_id)
);

CREATE INDEX IF NOT EXISTS meta_pages_workspace_active_idx
  ON public.meta_pages (workspace_id, is_active);
CREATE INDEX IF NOT EXISTS meta_pages_meta_page_id_idx
  ON public.meta_pages (meta_page_id);


-- ── social_comments ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.social_comments (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id                  UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  meta_page_id                  UUID NOT NULL REFERENCES public.meta_pages(id) ON DELETE CASCADE,

  -- Meta-side identifiers. All TEXT for the same reason as meta_pages.
  meta_comment_id               TEXT NOT NULL,
  meta_parent_comment_id        TEXT,                  -- if this is a reply to another comment
  meta_post_id                  TEXT NOT NULL,
  meta_sender_id                TEXT NOT NULL,
  meta_sender_name              TEXT,
  meta_sender_username          TEXT,                  -- IG username when available

  body                          TEXT NOT NULL,

  -- ── Classification ──
  -- is_ad denormalized from meta_post_cache so the list view can filter
  -- without a join. page_type also denormalized — admin filters need
  -- this and dynamic joins against meta_pages on every render would
  -- be wasted work.
  is_ad                         BOOLEAN NOT NULL DEFAULT false,
  page_type                     TEXT NOT NULL,
  ad_id                         TEXT,                  -- ad creative ID when is_ad
  sentiment                     TEXT,                  -- 'positive' | 'negative' | 'neutral' | 'spam' | 'abusive'
  matched_product_id            UUID REFERENCES public.products(id) ON DELETE SET NULL,

  -- ── Moderation state ──
  -- status:           'open'      = needs human or AI to look at it
  --                   'replied'   = we replied (AI or agent)
  --                   'hidden'    = hidden on Meta via Graph API
  --                   'deleted'   = deleted on Meta via Graph API
  --                   'ignored'   = AI decided no action; off the queue
  --                   'escalated' = AI asked for a human; sits in queue
  status                        TEXT NOT NULL DEFAULT 'open'
                                CHECK (status IN (
                                  'open', 'replied', 'hidden',
                                  'deleted', 'ignored', 'escalated'
                                )),

  -- moderation_source: who/what produced the most recent state change.
  --   'ai_auto'     = Sonnet ran and we executed its decision
  --   'ai_suggested'= Sonnet ran in sandbox mode; decision pending approval
  --   'agent_manual'= a human in the dashboard
  --   'rule'        = automatic rule (e.g. sender on the ban list)
  moderation_source             TEXT,

  -- AI suggestion fields — populated when Sonnet runs, regardless of
  -- whether we executed (live) or stashed for approval (sandbox).
  ai_action                     TEXT,
  ai_reply_body                 TEXT,
  ai_reasoning                  TEXT,
  ai_ran_at                     TIMESTAMPTZ,

  assigned_to                   UUID,                  -- agent on escalation

  -- ── Audit timestamps ──
  liked_at                      TIMESTAMPTZ,
  hidden_at                     TIMESTAMPTZ,
  hidden_by                     UUID,
  deleted_at                    TIMESTAMPTZ,
  deleted_by                    UUID,
  replied_at                    TIMESTAMPTZ,
  replied_by                    UUID,                  -- null = AI

  -- Meta-side state we mirror — 'edited' verb on webhook bumps this,
  -- 'remove' verb (user-deleted) sets deleted_by_user_at.
  edited_at                     TIMESTAMPTZ,
  deleted_by_user_at            TIMESTAMPTZ,

  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT social_comments_workspace_comment_key
    UNIQUE (workspace_id, meta_comment_id)
);

CREATE INDEX IF NOT EXISTS social_comments_workspace_status_idx
  ON public.social_comments (workspace_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS social_comments_page_idx
  ON public.social_comments (meta_page_id, created_at DESC);
CREATE INDEX IF NOT EXISTS social_comments_sender_idx
  ON public.social_comments (workspace_id, meta_sender_id);
CREATE INDEX IF NOT EXISTS social_comments_product_idx
  ON public.social_comments (matched_product_id) WHERE matched_product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS social_comments_post_idx
  ON public.social_comments (meta_post_id);


-- ── social_comment_replies ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.social_comment_replies (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id                  UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  social_comment_id             UUID NOT NULL REFERENCES public.social_comments(id) ON DELETE CASCADE,

  -- Meta's reply ID. For outbound replies, this is the ID Meta returns
  -- from POST /{comment-id}/comments — we store it as soon as the call
  -- succeeds. NULLable until then so we can pre-write the row with
  -- send_status='pending' for crash safety.
  meta_reply_id                 TEXT,

  meta_sender_id                TEXT,                  -- null for our outbound replies
  meta_sender_name              TEXT,

  direction                     TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  author_type                   TEXT NOT NULL CHECK (author_type IN ('customer', 'agent', 'ai', 'system')),
  author_user_id                UUID,                  -- agent who sent, if applicable

  body                          TEXT NOT NULL,

  -- Outbound delivery state — same pattern as ticket_messages.
  send_status                   TEXT CHECK (send_status IN ('pending', 'sent', 'failed')),
  send_error                    TEXT,

  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT social_comment_replies_workspace_reply_key
    UNIQUE (workspace_id, meta_reply_id)
);

CREATE INDEX IF NOT EXISTS social_comment_replies_comment_idx
  ON public.social_comment_replies (social_comment_id, created_at);


-- ── banned_meta_users ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.banned_meta_users (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id                  UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  meta_sender_id                TEXT NOT NULL,
  sender_name                   TEXT,
  sender_username               TEXT,
  reason                        TEXT,
  banned_by                     UUID,
  banned_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  unbanned_at                   TIMESTAMPTZ,
  unbanned_by                   UUID,

  CONSTRAINT banned_meta_users_workspace_sender_key
    UNIQUE (workspace_id, meta_sender_id)
);

-- Partial index for the active-only lookup pattern the webhook hits on
-- every incoming comment. Active = unbanned_at IS NULL.
CREATE INDEX IF NOT EXISTS banned_meta_users_workspace_active_idx
  ON public.banned_meta_users (workspace_id, meta_sender_id)
  WHERE unbanned_at IS NULL;


-- ── meta_post_cache ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.meta_post_cache (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id                  UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  meta_page_id                  UUID NOT NULL REFERENCES public.meta_pages(id) ON DELETE CASCADE,

  meta_post_id                  TEXT NOT NULL,
  is_ad                         BOOLEAN NOT NULL DEFAULT false,
  ad_id                         TEXT,
  permalink_url                 TEXT,
  message                       TEXT,                  -- post caption / body
  image_url                     TEXT,
  video_url                     TEXT,
  posted_at                     TIMESTAMPTZ,

  -- Extracted from message + ad attachments. Used by the product
  -- matching helper to pick the right products.handle.
  extracted_urls                TEXT[] NOT NULL DEFAULT '{}'::text[],
  matched_product_id            UUID REFERENCES public.products(id) ON DELETE SET NULL,

  last_refreshed_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT meta_post_cache_workspace_post_key
    UNIQUE (workspace_id, meta_post_id)
);

CREATE INDEX IF NOT EXISTS meta_post_cache_page_idx
  ON public.meta_post_cache (meta_page_id, posted_at DESC);


-- ── Backfill: legacy single-page workspaces → meta_pages ─────────
-- Any workspace that already connected a Meta page via the
-- workspaces.meta_page_* columns gets one meta_pages row. We default
-- page_type='brand' (admins flip to 'creator' in the new UI when
-- relevant). Webhook verify token moves over so existing subscriptions
-- keep verifying after the multi-page cutover.
INSERT INTO public.meta_pages (
  workspace_id,
  platform,
  meta_page_id,
  meta_page_name,
  meta_instagram_id,
  page_type,
  access_token_encrypted,
  webhook_verify_token,
  is_active
)
SELECT
  w.id,
  'facebook',
  w.meta_page_id,
  w.meta_page_name,
  w.meta_instagram_id,
  'brand',
  w.meta_page_access_token_encrypted,
  w.meta_webhook_verify_token,
  true
FROM public.workspaces w
WHERE w.meta_page_id IS NOT NULL
  AND w.meta_page_access_token_encrypted IS NOT NULL
ON CONFLICT (workspace_id, meta_page_id) DO NOTHING;


-- ── RLS ──────────────────────────────────────────────────────────
-- Authenticated dashboard users get SELECT scoped to their workspace.
-- All writes go through the admin client (service_role).

ALTER TABLE public.meta_pages              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_comments         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_comment_replies  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.banned_meta_users       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_post_cache         ENABLE ROW LEVEL SECURITY;

CREATE POLICY meta_pages_workspace_read ON public.meta_pages
  FOR SELECT TO authenticated
  USING (workspace_id = (auth.jwt() ->> 'workspace_id')::uuid);
CREATE POLICY meta_pages_service_all ON public.meta_pages
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY social_comments_workspace_read ON public.social_comments
  FOR SELECT TO authenticated
  USING (workspace_id = (auth.jwt() ->> 'workspace_id')::uuid);
CREATE POLICY social_comments_service_all ON public.social_comments
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY social_comment_replies_workspace_read ON public.social_comment_replies
  FOR SELECT TO authenticated
  USING (workspace_id = (auth.jwt() ->> 'workspace_id')::uuid);
CREATE POLICY social_comment_replies_service_all ON public.social_comment_replies
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY banned_meta_users_workspace_read ON public.banned_meta_users
  FOR SELECT TO authenticated
  USING (workspace_id = (auth.jwt() ->> 'workspace_id')::uuid);
CREATE POLICY banned_meta_users_service_all ON public.banned_meta_users
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY meta_post_cache_workspace_read ON public.meta_post_cache
  FOR SELECT TO authenticated
  USING (workspace_id = (auth.jwt() ->> 'workspace_id')::uuid);
CREATE POLICY meta_post_cache_service_all ON public.meta_post_cache
  FOR ALL TO service_role USING (true) WITH CHECK (true);
