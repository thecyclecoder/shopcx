-- agent-outage-resilience Phase 2 — Claude-down circuit-breaker state.
--
-- A single global singleton row holding the breaker's two health signals + derived state, so BOTH
-- runtimes can read it: Vercel/Inngest (the status-poll cron writes it; recordError reads it to
-- suppress the repair fan-out during an outage) and the build box (parks autonomous agent jobs
-- `blocked_on_dependency` when it's tripped, drains on recovery). Global infra, not workspace-scoped
-- (same as loop_heartbeats / error_events). Service role writes; the admin client bypasses RLS.

create table if not exists public.claude_health (
  id text primary key default 'singleton',

  -- External truth — status.claude.com/api/v2/components.json per-component status:
  -- operational | degraded_performance | partial_outage | major_outage | under_maintenance | unknown.
  api_status text not null default 'unknown',   -- the "Claude API (api.anthropic.com)" component
  code_status text not null default 'unknown',  -- the "Claude Code" component
  external_down boolean not null default false, -- derived: either component in partial/major outage
  last_polled_at timestamptz,                   -- when the poll last ran
  poll_ok boolean,                              -- could we reach Statuspage on the last poll? (null = never polled)

  -- Local signal — N consecutive retryable Claude failures (429/5xx/529/timeout) from our own calls.
  consecutive_failures int not null default 0,
  last_failure_at timestamptz,                  -- the local signal auto-expires (TTL) if no fresh failure

  -- Breaker (derived from both signals; persisted for cross-process reads + transition stamps).
  breaker_open boolean not null default false,  -- tripped = Claude is treated as DOWN
  tripped_at timestamptz,                       -- last false→true transition
  recovered_at timestamptz,                     -- last true→false transition
  detail text,                                  -- human-readable one-liner for the Control Tower tile
  updated_at timestamptz not null default now()
);

-- Seed the singleton (idempotent).
insert into public.claude_health (id) values ('singleton') on conflict (id) do nothing;

alter table public.claude_health enable row level security;
-- No policies → only the service-role admin client (which bypasses RLS) reads/writes it.

-- The error feed tags errors recorded WHILE the breaker is tripped as outage-correlated so the repair
-- agent treats them as symptoms of the outage (no churned per-error fix proposals), not new bugs.
alter table public.error_events add column if not exists outage_correlated boolean not null default false;
