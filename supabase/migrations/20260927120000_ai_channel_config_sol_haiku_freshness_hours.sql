-- ai_channel_config.sol_haiku_freshness_hours — freshness window (in hours) the model-picker
-- uses to gate the Haiku-tier route on a live Direction.
--
-- Phase 3 of docs/brain/specs/sol-cheap-execution-over-ticket-direction.md. When a ticket has a
-- live ticket_directions row (superseded_at IS NULL) whose authored_at is more recent than
-- (now() - sol_haiku_freshness_hours * interval '1 hour') AND the latest
-- ticket_resolution_events.confidence is >= ai_channel_config.problem_lockin_threshold AND the
-- Direction's chosen_path='stateless', the picker returns the Haiku tier instead of Sonnet — the
-- cost inversion this spec is the actual delivery of. When any leg of that predicate is false the
-- picker falls through to the existing Sonnet-vs-Opus rules (turn>=1, complex tags, crisis, etc.),
-- so this column can ONLY relax the picker toward Haiku, never push it away from Opus.
--
-- Nullable numeric so an operator can turn the branch OFF entirely per-channel (NULL → picker
-- treats freshness as "always stale" → never returns Haiku); default 24 matches the picker's
-- fallback when the column is null but the workspace/channel row is not, so the shipping default
-- is a 24-hour Haiku window without an operator touching the config. Idempotent
-- (ADD COLUMN IF NOT EXISTS).

ALTER TABLE public.ai_channel_config
  ADD COLUMN IF NOT EXISTS sol_haiku_freshness_hours numeric DEFAULT 24;
