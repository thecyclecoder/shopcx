-- media-buyer-director-slack-digest Phase 1: Growth-Director Slack channel config.
--
-- Mirrors workspaces.slack_ada_channel_id (added by 20260707120000_ada_slack_chat.sql):
--   workspaces.slack_growth_director_channel_id — the private #director-growth-max
--   channel id the Growth Director (Max) posts media-buyer shadow digests into. The
--   bot is already a member of the channel — a private channel needs only chat:write
--   for one-way posts (no fresh scope grant / no reinstall). See
--   docs/brain/lifecycles/ada-slack-chat.md + docs/brain/libraries/slack.md.
--
-- Seeds the Superfoods workspace so the Phase 2 digest delivery has a target on ship.
-- Additive + nullable — safe to apply ahead of the code.

alter table public.workspaces
  add column if not exists slack_growth_director_channel_id text;

update public.workspaces
   set slack_growth_director_channel_id = 'C0BFW5YUVC1'
 where id = 'fdc11e10-b89f-4989-8b73-ed6526c4d906'
   and (slack_growth_director_channel_id is null
        or slack_growth_director_channel_id <> 'C0BFW5YUVC1');
