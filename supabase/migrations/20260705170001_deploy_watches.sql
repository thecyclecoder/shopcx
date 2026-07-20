-- deploy-health-rollback-guardian Phase 1 — the deploy-watch store.
--
-- One row per auto-merged claude/<slug> deploy (the director's auto-fix path). When the auto-merge
-- gate squash-merges a build branch (→ a Vercel deploy), the Deploy Guardian (Reva) opens a
-- `deploy-watch` over a bounded canary window: it snapshots the PRE-deploy error/loop baseline, then a
-- minute-cadence cron evaluates the watch once the window elapses — attributing only signals that
-- FIRST appear AFTER the deploy timestamp (the correlation gate, mirroring agent-outage-resilience's
-- outage-correlation tagging) — and stamps a verdict: healthy | regressed | unsure. Phase 1 only
-- watches + verdicts; Phase 2 acts (auto-rollback) on `regressed`.
--
-- Workspace-scoped (mirrors director_activity): the watch carries the build-console workspace that
-- owned the build, so its verdict + the director_activity row it writes land in that workspace's
-- audit history / board / scorecard. Service role does all writes (the admin client bypasses RLS).

create table if not exists public.deploy_watches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  -- What deployed (the director's auto-fix path).
  slug text not null,                 -- the spec slug the merged build shipped
  branch text not null,               -- the claude/<slug> build branch that auto-merged
  pr_number int,                      -- the merged PR (null if unknown)
  merge_sha text,                     -- the squash-merge commit SHA (the deploy's identity)

  -- The canary window — the correlation gate origin + its bound.
  deployed_at timestamptz not null default now(),  -- the deploy timestamp; only signals first seen AFTER this are attributed
  window_ends_at timestamptz not null,             -- deployed_at + the canary window; evaluate once now() >= this

  -- The PRE-deploy baseline (belt-and-suspenders against attributing a pre-existing signal): the set of
  -- error signatures already present + loop_alerts already open at deploy time. A signal in the baseline
  -- is NOT new, even if it bumps during the window. { errorSignatures: string[], openLoopAlertIds: string[] }.
  baseline jsonb not null default '{}'::jsonb,

  -- The verdict (stamped on evaluation). `pending` until the window elapses + the cron evaluates it.
  verdict text not null default 'pending'
    check (verdict in ('pending', 'healthy', 'regressed', 'unsure')),
  evaluated_at timestamptz,           -- when the cron stamped the verdict
  -- What the evaluation saw: { newErrorSignatures: [...], newRedLoops: [...], redLoopCount, controlTowerOk }.
  findings jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now()
);

-- One watch per deploy: a re-run of the auto-merge path for the same squash SHA must not double-open.
-- Partial unique (merge_sha can be null when GitHub didn't return the SHA — those aren't de-duped).
create unique index if not exists deploy_watches_merge_sha_key
  on public.deploy_watches (merge_sha) where merge_sha is not null;

-- The cron's "what's due?" read: pending watches whose window has elapsed.
create index if not exists deploy_watches_pending_window_idx
  on public.deploy_watches (window_ends_at) where verdict = 'pending';

-- Per-workspace audit slice (the board / scorecard reads recent watches).
create index if not exists deploy_watches_ws_created_idx
  on public.deploy_watches (workspace_id, created_at desc);

alter table public.deploy_watches enable row level security;

-- Any authenticated user reads (the board / Control Tower surfaces are owner-gated above the DB);
-- service role does all writes (the admin client bypasses RLS). Mirrors director_activity.
drop policy if exists deploy_watches_read on public.deploy_watches;
create policy deploy_watches_read on public.deploy_watches
  for select to authenticated using (true);
