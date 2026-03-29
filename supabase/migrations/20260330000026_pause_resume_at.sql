-- Scheduled resume date for paused subscriptions
-- When set, an Inngest function will auto-resume the subscription at this time

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS pause_resume_at TIMESTAMPTZ;

COMMENT ON COLUMN subscriptions.pause_resume_at IS 'When set, Inngest auto-resumes this subscription at this timestamp. Cleared on manual resume.';
