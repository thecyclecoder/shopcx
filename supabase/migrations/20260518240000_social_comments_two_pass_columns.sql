-- Columns for the two-pass moderation pipeline:
--   Pass 1 (Haiku) — fast triage. Outputs classify into ai_action +
--     ai_reasoning. Auto-executes spam/sexual/abusive/irrelevant cases.
--   Pass 2 (Opus 4.7) — only runs on clean comments. KB + macro RAG.
--     Decides public-vs-hidden reply, drafts the message, captures the
--     reasoning across three lenses (helpfulness, public impact, sales).
--
-- And review columns: humans can rate the AI's decision after the fact,
-- and the analyzer page mines the bad ones for prompt-rule improvements.

ALTER TABLE social_comments
  ADD COLUMN IF NOT EXISTS ai_visibility    TEXT,           -- 'public' | 'hidden' (Pass 2 output)
  ADD COLUMN IF NOT EXISTS ai_considers     JSONB,          -- {helpfulness, public_impact, sales_consideration}
  ADD COLUMN IF NOT EXISTS ai_kb_sources    TEXT[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS ai_model         TEXT,           -- which model produced ai_action (haiku-4-5 / opus-4-7)

  ADD COLUMN IF NOT EXISTS human_rating       TEXT,         -- 'good' | 'bad' | 'needs_revision' | null
  ADD COLUMN IF NOT EXISTS human_rating_notes TEXT,
  ADD COLUMN IF NOT EXISTS human_rated_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS human_rated_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS social_comments_human_rating_idx
  ON social_comments (workspace_id, human_rating, created_at DESC)
  WHERE human_rating IS NOT NULL;
