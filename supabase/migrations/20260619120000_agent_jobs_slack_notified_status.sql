-- Slack Roadmap Console (Phase 5 watcher) — a per-job marker the Vercel watcher diffs against to
-- avoid re-posting the same transition to #roadmap. The cron posts only when status != this column,
-- then sets it. Idempotent: safe to re-run.
-- See docs/brain/specs/slack-roadmap-console-run-the-build-console-from-slack.md.
alter table public.agent_jobs
  add column if not exists slack_notified_status text;
