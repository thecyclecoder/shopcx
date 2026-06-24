-- director-executable-plans-and-priority: a director's one ACTIVE directive — a CEO-handed plan that the
-- standing pass runs FIRST (before routine lanes) and can gate the build queue until a fix ships. Created
-- via the coaching seat's `plan` intent, CEO-approved. One active per (workspace, director_function).
create table if not exists public.director_directives (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  director_function text not null,
  summary text not null,
  steps jsonb not null default '[]'::jsonb,          -- ordered plan steps (strings), surfaced + pursued first
  gate_builds_until text,                            -- a spec slug; while it's unshipped, build-enqueue lanes pause
  status text not null default 'active',             -- active | done | cleared
  created_by uuid,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

-- One ACTIVE directive per director (a new one supersedes; code clears the prior first, this is the backstop).
create unique index if not exists director_directives_one_active
  on public.director_directives (workspace_id, director_function)
  where status = 'active';

create index if not exists director_directives_lookup
  on public.director_directives (workspace_id, director_function, status);
