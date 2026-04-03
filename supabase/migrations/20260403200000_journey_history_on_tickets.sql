-- Track journey deliveries per ticket for re-nudge logic
ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS journey_history JSONB NOT NULL DEFAULT '[]';

-- Example structure:
-- [{ "journey_id": "uuid", "journey_name": "Cancel", "sent_at": "iso", "nudged_at": null, "completed": false }]
