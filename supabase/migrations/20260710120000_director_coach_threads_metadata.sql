-- ada-slack-routed-approvals Phase 3 — chat-mode for complex CEO approvals.
--
-- Adds a metadata jsonb column to director_coach_threads so a chat-mode invitation thread can
-- carry the routed approval's context (agent_job_id, notification_id, spec_slug, kind, the
-- investigation preview). When the founder replies in the Slack thread the events handler
-- continues the same thread, and the box turn reads the pre-seeded context out of metadata.
--
-- Additive + nullable + defaulted — safe to apply ahead of the code. See
-- docs/brain/specs/ada-slack-routed-approvals.md (Phase 3).

alter table public.director_coach_threads
  add column if not exists metadata jsonb not null default '{}'::jsonb;
