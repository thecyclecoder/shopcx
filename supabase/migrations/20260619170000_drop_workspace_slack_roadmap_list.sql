-- Retire the Slack List roadmap mirror (slack-home-detail Phase 1). The native Slack List has been
-- replaced by the in-Slack spec-detail modal on the App Home tab — see docs/brain/specs/slack-home-detail.md.
-- The cached List handle column is no longer read or written by any code, so drop it. Idempotent.

alter table public.workspaces
  drop column if exists slack_roadmap_list;
