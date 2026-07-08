-- media-buyer-arming-gate Phase 1 — the deterministic arming-gate authorization ledger
-- for [[../../docs/brain/goals/autonomous-media-buyer-supervision]] M3 "Armed
-- (bounded autonomous execution)". One row per (workspace, meta_ad_account, iso_week)
-- pinning whether the Media Buyer cohort is authorized to move from shadow → armed
-- for THAT week, plus the structured `reasons` array that carries the denial branches
-- (insufficient_sample, low_agreement, trust_streak_short, blended_cac_ltv_below_target,
-- blended_cac_ltv_unknown). The gate write is the ONLY authoritative surface for the
-- flip — a `dashboard_notifications` escalation on deny is emitted via
-- [[../../src/lib/agents/platform-director.ts]] `escalateDiagnosisToCeo` and audit-mirrored
-- to [[../../docs/brain/tables/director_activity]] `media_buyer_arming_denied`.
--
-- Scope axes:
--   workspace_id       — NOT NULL; the authorization always belongs to one workspace.
--   meta_ad_account_id — NULL = workspace-wide row; non-null = per-account row.
--   iso_week           — ISO 8601 week label (`YYYY-Www`) — the sample window resets
--                        weekly, so the row is week-scoped.
--
-- Uniqueness is enforced by a partial-expression index that folds NULL
-- meta_ad_account_id to '' so a workspace-wide row can coexist with per-account rows
-- on the same iso_week (mirrors `media_buyer_sensor_trust`'s upsert key).

create table if not exists public.media_buyer_arming_authorization (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  meta_ad_account_id uuid references public.meta_ad_accounts(id),
  iso_week text not null,
  allowed boolean not null,
  reasons jsonb not null default '[]'::jsonb,
  evaluated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One authorization per (workspace, meta_ad_account, iso_week). NULL
-- meta_ad_account_id folds to '' so a workspace-wide row coexists with per-account
-- rows for the same week without colliding.
create unique index if not exists media_buyer_arming_authorization_ws_account_week_key
  on public.media_buyer_arming_authorization
    (workspace_id, coalesce(meta_ad_account_id::text, ''), iso_week);

-- updated_at auto-bump so an upsert re-write bumps the timestamp (re-evaluation
-- within the same iso_week is legal — the newest evaluation wins).
create or replace function public.media_buyer_arming_authorization_touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists media_buyer_arming_authorization_touch_updated_at on public.media_buyer_arming_authorization;
create trigger media_buyer_arming_authorization_touch_updated_at
  before update on public.media_buyer_arming_authorization
  for each row execute function public.media_buyer_arming_authorization_touch_updated_at();

alter table public.media_buyer_arming_authorization enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'media_buyer_arming_authorization' and policyname = 'media_buyer_arming_authorization_select') then
    create policy media_buyer_arming_authorization_select on public.media_buyer_arming_authorization for select
      using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'media_buyer_arming_authorization' and policyname = 'media_buyer_arming_authorization_service') then
    create policy media_buyer_arming_authorization_service on public.media_buyer_arming_authorization for all
      using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
end $$;
