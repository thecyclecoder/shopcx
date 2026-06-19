-- Slack List mirror of the roadmap (slack-roadmap-home Phase 3): a native Slack List is the
-- at-a-glance PM table for specs. The List is created once per workspace by the bot; we cache its
-- handle here as { "id": "F…", "cols": { "<schema key>": "<generated column id>", … } } so later
-- syncs reconcile the SAME List (and address cells by their generated column ids) instead of
-- creating duplicates. Null = "not yet created" — the next sync creates it and backfills this.
-- The brain (docs/brain/specs/*.md) stays the source of truth; this only caches the Slack handle.
-- See docs/brain/specs/slack-roadmap-home.md + docs/brain/libraries/slack-list.md.

alter table public.workspaces
  add column if not exists slack_roadmap_list jsonb;
