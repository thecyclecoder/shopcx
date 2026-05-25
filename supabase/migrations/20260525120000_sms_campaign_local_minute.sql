-- Per-recipient local send time gains minute granularity. Until now
-- target_local_hour was the only knob, which forced campaign schedules
-- onto the hour. Memorial Day final-day push wanted 9:45 AM local — no
-- workaround without adding the column.

ALTER TABLE public.sms_campaigns
  ADD COLUMN IF NOT EXISTS target_local_minute INTEGER NOT NULL DEFAULT 0
    CHECK (target_local_minute >= 0 AND target_local_minute <= 59);

ALTER TABLE public.sms_campaigns
  ADD COLUMN IF NOT EXISTS fallback_target_local_minute INTEGER NOT NULL DEFAULT 0
    CHECK (fallback_target_local_minute >= 0 AND fallback_target_local_minute <= 59);
