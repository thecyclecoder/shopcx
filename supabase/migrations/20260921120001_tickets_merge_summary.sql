-- Ticket merge summary + context cap Phase 1 —
-- (docs/brain/specs/ticket-merge-summary-and-context-cap.md, Phase 1)
--
-- Add two columns to public.tickets that lock in the state of a merged
-- thread at merge time so downstream orchestrator turns can read the
-- summary instead of re-costing the full pre-merge history to Opus on
-- every call.
--
--   merge_summary     — compact plain-text state summary (issue,
--                       confirmed facts, actions, open items) produced
--                       by Sonnet at merge time via
--                       src/lib/ticket-merge.ts.
--   merge_summary_at  — timestamp of the summary write. Phase 2 will
--                       assemble the model context as
--                         merge_summary  +  messages since
--                       merge_summary_at, so this doubles as the
--                       "stable prefix / since window" boundary.
--
-- Both nullable. Existing rows leave the columns NULL — the summary is
-- only populated by a merge event, and Phase 2's context assembly falls
-- back to today's behavior when merge_summary is NULL. Idempotent:
-- IF NOT EXISTS on both.

alter table public.tickets
  add column if not exists merge_summary text,
  add column if not exists merge_summary_at timestamptz;
