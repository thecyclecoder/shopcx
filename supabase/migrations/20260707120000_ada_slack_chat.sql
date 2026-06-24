-- ada-slack-chat: two-way Slack chat with Ada in the #cto-ada channel.
--
-- Adds the columns that let a Slack message become a director_coach_thread turn and
-- route Ada's reply back to the right Slack channel/thread:
--   workspaces.slack_ada_channel_id        — the #cto-ada channel id (set by /ada-here)
--   director_coach_threads.source          — 'web' (default) | 'slack'
--   director_coach_threads.slack_channel_id — the channel a slack-origin thread posts back to
--   director_coach_threads.slack_thread_ts  — the Slack thread root ts (the conversation key)
--
-- All additive + nullable — safe to apply ahead of the code. See docs/brain/specs/ada-slack-chat.md.

alter table public.workspaces
  add column if not exists slack_ada_channel_id text;

alter table public.director_coach_threads
  add column if not exists source text not null default 'web',
  add column if not exists slack_channel_id text,
  add column if not exists slack_thread_ts text;

-- A slack-origin thread is looked up by its Slack thread root ts when a reply lands.
create index if not exists idx_director_coach_threads_slack_thread
  on public.director_coach_threads (workspace_id, slack_thread_ts)
  where slack_thread_ts is not null;
