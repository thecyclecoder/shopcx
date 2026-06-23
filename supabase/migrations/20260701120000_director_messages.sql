-- director_messages — the board store behind the gamified #directors board's Messages tab
-- (see docs/brain/specs/directors-board-gamified.md, Phase 1).
--
-- The Messages tab of the M1 Agents-hub inbox is built as a Slack-style TEAM CHANNEL (not a log):
-- each director is a character (persona from src/lib/agents/personas.ts) posting conversational,
-- human-readable updates, with threading + @-mentions. The CEO replies in-thread (Phase 2), the
-- day closes with an EOD recap post (Phase 4). This table is that channel.
--
-- A post is authored either by a DIRECTOR (author='director' + author_function = the function slug,
-- e.g. 'platform'), by the CEO (author='ceo', author_function null), or by the SYSTEM (author='system'
-- — the seeded post that proves the surface until the live Platform director (M4) is the first real
-- author). `kind` ∈ update｜reply｜recap｜approval-note; `parent_message_id` threads replies under a
-- post; `mentions` carries @-mentioned slugs/handles; `metadata` carries per-post structured context
-- (e.g. the spec/job/decision a post references, the dev-ask thread id a reply came from — Phase 2).
--
-- Workspace-scoped (mirrors spec_card_state / the inbox). RLS: any authenticated user reads (the page +
-- the board API are owner-gated above the DB); service role does all writes (the seed, the future
-- Platform director, the EOD recap cron). XP is DERIVED elsewhere (Phase 3) — never stored here.

create table if not exists public.director_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- who posted: a director (with author_function), the CEO, or the system seed.
  author text not null default 'director' check (author in ('director', 'ceo', 'system')),
  -- the function slug for a director post (e.g. 'platform') — null for ceo/system. Resolves a persona.
  author_function text,
  -- the conversational, human-readable body (plain prose — a board, not a log).
  body text not null,
  -- post kind: a board update, an in-thread reply, an EOD recap standup, or an approval note.
  kind text not null default 'update' check (kind in ('update', 'reply', 'recap', 'approval-note')),
  -- threading: a reply points at the post it answers (null = a top-level channel post).
  parent_message_id uuid references public.director_messages(id) on delete cascade,
  -- @-mentioned handles/slugs (e.g. {'ceo','platform'}) — drives Phase 2 routing.
  mentions text[] not null default '{}',
  -- structured per-post context: { spec_slug?, job_id?, decision_id?, thread_id?, ... }.
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- The channel read: a workspace's posts newest-first.
create index if not exists director_messages_ws_created_idx
  on public.director_messages (workspace_id, created_at desc);
-- Thread fan-out: replies under a post.
create index if not exists director_messages_parent_idx
  on public.director_messages (parent_message_id);

alter table public.director_messages enable row level security;
drop policy if exists director_messages_select on public.director_messages;
create policy director_messages_select on public.director_messages
  for select to authenticated using (auth.uid() is not null);
drop policy if exists director_messages_service on public.director_messages;
create policy director_messages_service on public.director_messages
  for all to service_role using (true) with check (true);
