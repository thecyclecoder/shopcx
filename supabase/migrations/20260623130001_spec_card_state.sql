-- spec_card_state — the live, instant project-management mirror the roadmap board reads DB-first
-- (see docs/brain/specs/spec-card-db-companion.md). Supersedes the disabled roadmap-reads-specs-from-git.
--
-- A card's status used to be parsed only from the spec markdown's phase emojis AS BUNDLED IN THE DEPLOYED
-- build, so a merge / drift flip / owner mark didn't show until a markdown edit + commit + Vercel deploy.
-- This table is the *live* mirror the board reads instantly: the merge / drift / owner / build paths write
-- it the moment the event happens. The markdown stays CANONICAL for spec content + the durable phase record;
-- this is only the board mirror + transient flags (deploy_pending, blocked) that don't belong in committed
-- markdown. On a true status conflict the markdown wins (the board takes whichever is further along, and the
-- spec-drift reconciler + the fold keep the two in sync).
--
-- Workspace-scoped (mirrors spec_drift). RLS: any authenticated user reads; service role does all writes
-- (the writers run with the service-role creds). One row per (workspace, spec_slug) — the upsert spine.

create table if not exists public.spec_card_state (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- the spec this mirrors (docs/brain/specs/{slug}.md).
  spec_slug text not null,
  -- derived overall status — the board takes max(markdown, this), so this only ever moves a card forward.
  status text not null default 'planned' check (status in ('planned', 'in_progress', 'shipped', 'rejected')),
  -- per-phase snapshot [{ index, title, status }] at write time (board future-use; status is the board signal).
  phase_states jsonb not null default '[]'::jsonb,
  -- transient board flags that don't belong in committed markdown: { deploy_pending?, blocked?, ... }.
  flags jsonb not null default '{}'::jsonb,
  -- the build merge commit SHA whose code shipped this card — compared against VERCEL_GIT_COMMIT_SHA to tell
  -- "shipped · deploying" (merge not yet live) from "shipped · live" (a deploy carrying this SHA is live).
  last_merge_sha text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per (workspace, spec) — the upsert spine (writers upsert onConflict (workspace_id, spec_slug)).
create unique index if not exists spec_card_state_ws_slug
  on public.spec_card_state (workspace_id, spec_slug);
create index if not exists spec_card_state_ws_idx
  on public.spec_card_state (workspace_id);

alter table public.spec_card_state enable row level security;
drop policy if exists spec_card_state_select on public.spec_card_state;
create policy spec_card_state_select on public.spec_card_state
  for select to authenticated using (auth.uid() is not null);
drop policy if exists spec_card_state_service on public.spec_card_state;
create policy spec_card_state_service on public.spec_card_state
  for all to service_role using (true) with check (true);
