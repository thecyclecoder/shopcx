-- ai_channel_config.problem_lockin_threshold — per-channel confidence gate for the
-- "problem-lock-in" prompt block in src/lib/ai-context.ts.
--
-- Phase 1 of docs/brain/specs/confidence-gated-problem-lockin-and-selective-clarify.md
-- (parent goal: guaranteed-ticket-handling → M2 "The resolution record (the spine)"). When
-- the latest ticket_resolution_events row for a ticket carries confidence >= this value,
-- assembleTicketContext() injects an ESTABLISHED PROBLEM line into the Sonnet system prompt
-- ("ESTABLISHED PROBLEM (locked in at T{N}): {problem}. Any pivot MUST be justified…"), so
-- Sonnet stops silently pivoting off a high-confidence early diagnosis on later turns.
--
-- Default 0.7 aligns with the goal's ~6% selective-clarify target — high enough to filter
-- out early low-confidence guesses, low enough to lock in the vast majority of resolutions.
-- Idempotent: ADD COLUMN IF NOT EXISTS + DO-block CHECK guard.

ALTER TABLE public.ai_channel_config
  ADD COLUMN IF NOT EXISTS problem_lockin_threshold numeric NOT NULL DEFAULT 0.7;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_channel_config_problem_lockin_threshold_range'
  ) THEN
    ALTER TABLE public.ai_channel_config
      ADD CONSTRAINT ai_channel_config_problem_lockin_threshold_range
      CHECK (problem_lockin_threshold >= 0 AND problem_lockin_threshold <= 1);
  END IF;
END $$;
