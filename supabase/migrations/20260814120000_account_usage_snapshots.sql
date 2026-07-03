-- account_usage_snapshots + usage_wall_events: Phase 1 of docs/brain/specs/
-- fleet-usage-cockpit.md.
--
-- account_usage_snapshots — per-account (Max Round Robin 1..4 + Codex) rollups
-- of the 5-hour and trailing-weekly token burn windows, written by BOTH the
-- box (source='box' — summed from agent_job_costs, joined to the live cap
-- state) and the Mac reporter (source='mac' — ccusage). The cockpit page
-- (Phase 3) sums box+mac per account. Uniquely keyed on (workspace_id, source,
-- account, window) so a re-report REPLACES the prior slice.
--
-- usage_wall_events — one row per detected Max usage wall. Records the token
-- burn AT the moment the wall hit + the window classification (5h vs weekly),
-- so `discoverLimit(account, window)` = MAX(tokens_at_wall) tightens toward the
-- true hidden limit as more walls are sampled. Claude/Max only — Codex's limit
-- comes from its `/status` %.
--
-- Neither carries a customer_id → the CLAUDE.md Sonnet-data-tool rule for
-- customer-referenced tables does not apply.
--
-- Owner-only surface — RLS narrows to workspace-member SELECT + service-role
-- full access (owner-gating happens at the API above).

create table if not exists public.account_usage_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- Where the snapshot was captured. 'box' = builder-worker rollup over
  -- agent_job_costs + live cap state. 'mac' = the founder's local Mac
  -- reporter (ccusage on ~/.claude + ~/.codex/sessions), owner-authed POST.
  source text not null check (source in ('box','mac')),
  -- Which agent runtime the account runs. 'claude' = a Max Round Robin lane.
  -- 'codex' = the ChatGPT-plan device-code login (single account).
  runtime text not null check (runtime in ('claude','codex')),
  -- Human label for the account. Matches the live agent_job_costs.account
  -- values: 'Round Robin 1'..'Round Robin 4' for Max, 'codex' for Codex.
  account text not null,
  -- Which usage window this row rolls up. '5h' = Anthropic's rolling 5-hour
  -- session window (Codex reuses the same slot for its rolling window). 'weekly'
  -- = the trailing 7-day window (the seven_day / weekly / opus_weekly wall).
  window text not null check (window in ('5h','weekly')),
  -- Wall-clock the window started (or "now - windowLength" for a trailing
  -- window when no exact start is known). Informational — the unique key is
  -- (workspace, source, account, window) so a re-rollup replaces the prior row.
  window_start timestamptz,
  -- When the window is scheduled to reset (from the parsed wall message when
  -- known, or the account's live cappedUntil). NULL when unknown.
  window_reset_at timestamptz,
  -- Token burn in this window. Sums the four agent_job_costs token columns
  -- for source='box'; the ccusage per-block totals for source='mac'.
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_creation_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  -- True when the account was capped at capture (AccountState.cappedUntil >
  -- now / codexState.cappedUntil > now / ccusage says the block hit a wall).
  capped boolean not null default false,
  -- The cap's stated reset — mirrors window_reset_at for a capped row; NULL
  -- when not capped.
  capped_until timestamptz,
  -- Codex only: the reported /status percentage (0..100). Claude leaves this
  -- NULL — its % comes from burn / discoverLimit (Phase 3).
  limit_pct numeric,
  -- Wall-clock the source captured this row (ccusage block end / box rollup
  -- tick). May trail created_at slightly.
  captured_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, source, account, window)
);

comment on table public.account_usage_snapshots is
  'Per-account (Max Round Robin 1..4 + Codex) token-burn rollups keyed by source (box|mac) + window (5h|weekly). '
  'The Phase-3 /developer/usage cockpit SUMs box+mac per account. No customer_id → the Sonnet data tool rule does not apply.';

create index if not exists account_usage_snapshots_ws_idx
  on public.account_usage_snapshots (workspace_id, account, window);
create index if not exists account_usage_snapshots_captured_idx
  on public.account_usage_snapshots (captured_at desc);

create or replace function public.account_usage_snapshots_touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists account_usage_snapshots_touch_updated_at on public.account_usage_snapshots;
create trigger account_usage_snapshots_touch_updated_at
  before update on public.account_usage_snapshots
  for each row execute function public.account_usage_snapshots_touch_updated_at();

alter table public.account_usage_snapshots enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'account_usage_snapshots' and policyname = 'account_usage_snapshots_select') then
    create policy account_usage_snapshots_select on public.account_usage_snapshots for select
      using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'account_usage_snapshots' and policyname = 'account_usage_snapshots_service') then
    create policy account_usage_snapshots_service on public.account_usage_snapshots for all
      using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
end $$;

-- usage_wall_events — every detected Max wall stamped with the window's
-- token burn AT the moment of the wall + the window classification. Powers
-- discoverLimit(account, window) = MAX(tokens_at_wall) over this table.
create table if not exists public.usage_wall_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- Account the wall hit (matches account_usage_snapshots.account labels).
  account text not null,
  runtime text not null check (runtime in ('claude','codex')),
  -- Which window the wall belonged to ('5h' = session, 'weekly' = seven_day /
  -- monthly). Classified via isWeeklyWall(wall_text) in builder-worker.
  window text not null check (window in ('5h','weekly')),
  -- The token burn recorded for the account+window at the moment the wall hit
  -- — this is the LOWER-BOUND estimate of the true hidden Max limit. MAX over
  -- this column across walls converges toward the real ceiling.
  tokens_at_wall bigint not null default 0,
  -- The raw wall text (429 body / "usage limit reached …"). Kept for post-hoc
  -- classification + debugging; NEVER surfaced to a non-owner.
  wall_text text,
  -- The wall's stated reset time (parseResetTime on wall_text), when parseable.
  wall_reset_at timestamptz,
  observed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

comment on table public.usage_wall_events is
  'One row per detected Max/Claude usage wall — stamped with the window''s token burn + classification (5h|weekly). '
  'discoverLimit(account, window) reads MAX(tokens_at_wall). Codex uses /status %; Codex wall events are recorded but discoverLimit returns null for them.';

create index if not exists usage_wall_events_ws_account_idx
  on public.usage_wall_events (workspace_id, account, window, observed_at desc);
create index if not exists usage_wall_events_observed_idx
  on public.usage_wall_events (observed_at desc);

alter table public.usage_wall_events enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'usage_wall_events' and policyname = 'usage_wall_events_select') then
    create policy usage_wall_events_select on public.usage_wall_events for select
      using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'usage_wall_events' and policyname = 'usage_wall_events_service') then
    create policy usage_wall_events_service on public.usage_wall_events for all
      using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
end $$;
