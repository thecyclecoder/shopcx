-- director_directives — the CEO's executable PLAN store (director-executable-plans-and-priority Phase 1).
--
-- A directive is a plan the CEO hands a director through the ask/coach chat (the `plan` intent): it
-- re-prioritizes WHAT the director does until done — "build X first / gate builds until Y" — without
-- loosening HOW (the leash, loop-guard, soundness gate, escalation rails are unchanged). The director
-- investigates read-only, emits a `directive` approval card, and on the CEO's approval the worker inserts
-- ONE active row here. The standing pass (Phase 2) loads the one `active` directive and runs it FIRST,
-- before the routine lanes; the build-gate pauses build-enqueue while `gate_builds_until` is unshipped.
--
-- `director_function` = the function slug the directive is FOR (e.g. 'platform' — Ada). `steps` is the
-- ordered plan (a jsonb array of plain-text steps). `gate_builds_until` is an optional spec slug: while
-- it's set and that spec is unshipped, the director STOPS queuing new builds (the gate auto-lifts when it
-- ships, and the directive auto-completes). `status` is active｜done｜cleared (the CEO can clear it any
-- time). At most ONE active directive per (workspace, director) — enforced by a partial unique index.
--
-- Workspace-scoped (mirrors director_activity / director_messages). RLS: any authenticated user reads
-- (the surfaces are owner-gated above the DB); service role does all writes.

create table if not exists public.director_directives (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- the function slug the directive is FOR (the director who must execute it).
  director_function text not null,
  -- one-line summary of the plan (shown on the chat card + the Agents hub).
  summary text not null,
  -- the ordered plan: a jsonb array of plain-text steps the director pursues directive-first.
  steps jsonb not null default '[]'::jsonb,
  -- optional spec slug: while set + that spec is unshipped, the director pauses build-enqueue (the gate).
  gate_builds_until text,
  -- active｜done｜cleared. One active directive per (workspace, director); done = the gate's spec shipped;
  -- cleared = the CEO cleared it (or it was superseded by a newer directive). No CHECK — open vocabulary.
  status text not null default 'active',
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

-- At most ONE active directive per director in a workspace (the standing pass loads "the one active").
create unique index if not exists director_directives_one_active_idx
  on public.director_directives (workspace_id, director_function)
  where status = 'active';
-- Per-director history, newest-first (the Agents hub + audit read).
create index if not exists director_directives_ws_dir_created_idx
  on public.director_directives (workspace_id, director_function, created_at desc);

alter table public.director_directives enable row level security;
drop policy if exists director_directives_select on public.director_directives;
create policy director_directives_select on public.director_directives
  for select to authenticated using (auth.uid() is not null);
drop policy if exists director_directives_service on public.director_directives;
create policy director_directives_service on public.director_directives
  for all to service_role using (true) with check (true);
