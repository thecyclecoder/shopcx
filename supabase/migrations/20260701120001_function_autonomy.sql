-- function_autonomy — the per-function live+autonomous flag (approval-routing-engine spec, Phase 1).
--
-- The progressive-offload switch behind the org-chart approval router. resolveApprover
-- (src/lib/agents/approval-router.ts) walks UP from a raising tool's owner function to the first
-- ancestor that is BOTH `live` (its director-agent is running) AND `autonomous` (trusted to auto-
-- decide); if none qualifies, it falls through to the CEO — the fail-safe root.
--
-- Seeded ALL-OFF — today's reality: no director is automated, so every approval routes to the one
-- CEO inbox (fail-safe: an unconfigured / partially-configured org never silently auto-approves).
-- The workspace owner toggles a function on from the Agents hub (/dashboard/agents) once its
-- director-agent is trusted.
--
-- GLOBAL config (one row per function slug) — the org chart is ShopCX's own internal DevOps org,
-- singular; this is not per-tenant data, so there is no workspace_id. The slug is the PK. Read +
-- written via the service role (createAdminClient); the toggle API is owner-gated above the DB.
-- RLS: any authenticated user reads (the hub is owner-gated in the route); service role does writes.

create table if not exists public.function_autonomy (
  -- the function slug — matches docs/brain/functions/{slug}.md (e.g. 'platform', 'growth'). PK.
  function_slug text primary key,
  -- the director-agent is running (M4). Necessary-but-not-sufficient for auto-approval.
  live boolean not null default false,
  -- the director is trusted to auto-decide. live && autonomous ⇒ this function is an auto-approver.
  autonomous boolean not null default false,
  -- the workspace_members.display_name (or system actor) that last flipped a flag — audit trail.
  updated_by text,
  updated_at timestamptz not null default now()
);

alter table public.function_autonomy enable row level security;
drop policy if exists function_autonomy_select on public.function_autonomy;
create policy function_autonomy_select on public.function_autonomy
  for select to authenticated using (auth.uid() is not null);
drop policy if exists function_autonomy_service on public.function_autonomy;
create policy function_autonomy_service on public.function_autonomy
  for all to service_role using (true) with check (true);

-- Seed every known function ALL-OFF (idempotent). The CEO seat is implicit — it is the router's
-- fallback root, never a row here. A brand-new functions/*.md director with no row is treated as
-- off by the router's "missing row ⇒ {live:false}" rule, so this seed is a convenience for the
-- toggle UI, not a correctness dependency.
insert into public.function_autonomy (function_slug, live, autonomous)
values
  ('growth', false, false),
  ('cmo', false, false),
  ('retention', false, false),
  ('cs', false, false),
  ('platform', false, false)
on conflict (function_slug) do nothing;
