-- SMS Marketing Agent (CMO / Iris) — the CMO-side mirror of the Growth Storefront
-- Optimizer stack. Three tables + two columns. Ships DORMANT: sms_marketing_policy.active
-- defaults false, and no workspace is seeded active by this DDL (the seed script sets up
-- Superfoods' policy + templates but leaves active=false — Iris/Dylan flips it on).
--
-- See docs/brain/inngest/sms-marketing.md · docs/brain/tables/sms_marketing_policy.md ·
-- docs/brain/tables/sms_campaign_templates.md · docs/brain/tables/sms_campaign_grades.md.

-- ════════════════════════════════════════════════════════════════════════════════
-- 1. sms_marketing_policy — the bounded proxy + dormant on-switch (mirror
--    storefront_optimizer_policy). One row per workspace.
-- ════════════════════════════════════════════════════════════════════════════════
create table if not exists public.sms_marketing_policy (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  -- ── the on-switch ────────────────────────────────────────────────────────────
  -- "the agent proposes + schedules sends at all." Default OFF (dormant on any workspace).
  active boolean not null default false,

  -- ── cadence guardrails (the bounded proxy) ───────────────────────────────────
  weekly_send_cap integer not null default 2,          -- max campaign-events (send days) per ISO week
  min_days_between_sends integer not null default 2,   -- fatigue guard between send days

  -- Allowed send windows the agent may fire in — the candidate slots Dylan named:
  -- Sun AM, Mon AM, Tue PM, Thu AM, Sat AM. jsonb array of
  -- { weekday:0-6 (0=Sun), hour:0-23, theme:'vip'|'weekend' }. Enforced, never narrative.
  send_windows jsonb not null default '[]'::jsonb,

  -- Segment allowlist the agent may text (enforced). `cold` is never included — the
  -- 92%-of-book spam tax (docs/brain/sms-segment-performance.md).
  segment_scope jsonb not null default
    '["cycle_hitter","lapsed","engaged","deep_lapsed","single_order","active_sub"]'::jsonb,

  -- Per-theme offer wiring — the coupon code + landing collection + discount label the
  -- agent stamps onto each campaign. { "vip": {code,collection,discount_label},
  -- "weekend": {...} }. Codes are pre-existing Shopify codes (coupon_enabled=false path,
  -- the proven pattern) — Dylan sets real codes before activating. Empty ⇒ agent has no
  -- offer to send and skips (a rail, not a guess).
  theme_config jsonb not null default '{}'::jsonb,

  -- ── authorship / legibility (agent-writable via the authoring lib, human via UI) ──
  created_by text not null default 'human' check (created_by in ('agent', 'human')),
  updated_by uuid,                                     -- last editor (auth.users id; no FK, mirrors sibling tables)
  rationale text,                                      -- why this policy is set as it is (Iris legibility)

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists sms_marketing_policy_ws_key
  on public.sms_marketing_policy (workspace_id);

alter table public.sms_marketing_policy enable row level security;
drop policy if exists sms_marketing_policy_select on public.sms_marketing_policy;
create policy sms_marketing_policy_select on public.sms_marketing_policy
  for select to authenticated using (auth.uid() is not null);
drop policy if exists sms_marketing_policy_service on public.sms_marketing_policy;
create policy sms_marketing_policy_service on public.sms_marketing_policy
  for all to service_role using (true) with check (true);

-- ════════════════════════════════════════════════════════════════════════════════
-- 2. sms_campaign_templates — the DB-driven copy library (never hardcoded, per
--    CLAUDE.md). Keyed by (theme, segment). Body composes as:
--       {hook}\n\n{cta}\n{shortlink}\n\n{signoff}
--    matching the shipped July 4th send. segment='*' is the theme's default fallback.
-- ════════════════════════════════════════════════════════════════════════════════
create table if not exists public.sms_campaign_templates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  theme text not null,                                 -- 'vip' | 'weekend'
  segment text not null,                               -- archetype segment, or '*' fallback
  hook text not null,                                  -- block 1 (segment-specific)
  cta text not null,                                   -- block 2 label above {shortlink}
  signoff text not null,                               -- last block: benefit payoff + urgency
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists sms_campaign_templates_key
  on public.sms_campaign_templates (workspace_id, theme, segment);

alter table public.sms_campaign_templates enable row level security;
drop policy if exists sms_campaign_templates_select on public.sms_campaign_templates;
create policy sms_campaign_templates_select on public.sms_campaign_templates
  for select to authenticated using (auth.uid() is not null);
drop policy if exists sms_campaign_templates_service on public.sms_campaign_templates;
create policy sms_campaign_templates_service on public.sms_campaign_templates
  for all to service_role using (true) with check (true);

-- ════════════════════════════════════════════════════════════════════════════════
-- 3. sms_campaign_grades — KPI grading (mirror storefront_campaign_grades). One row
--    per graded campaign. KPI = revenue-per-send (docs/brain/sms-segment-performance.md).
--    hypothesis_quality (was the theme/segment/timing a sound bet) scored SEPARATELY
--    from result_quality (did it convert) — a sound bet that lost still grades well.
-- ════════════════════════════════════════════════════════════════════════════════
create table if not exists public.sms_campaign_grades (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  campaign_id uuid not null references public.sms_campaigns(id) on delete cascade,

  grade_initial integer,                               -- 1-10 at early signal (clicks / early orders)
  grade_revised integer,                               -- 1-10 after the coupon window closes (attributed revenue)
  hypothesis_quality integer,                          -- 1-10: sound theme/segment/timing bet?
  result_quality integer,                              -- 1-10: did it convert?

  sent integer,                                        -- delivered recipients
  revenue_cents integer,                               -- UTM-attributed revenue (KPI numerator)
  rev_per_send_cents integer,                          -- revenue_cents / sent — the KPI

  reasoning text,                                      -- evidence-based grader reasoning (Iris)
  graded_by text,                                      -- 'iris' | 'human' | 'auto'

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists sms_campaign_grades_campaign_key
  on public.sms_campaign_grades (campaign_id);

alter table public.sms_campaign_grades enable row level security;
drop policy if exists sms_campaign_grades_select on public.sms_campaign_grades;
create policy sms_campaign_grades_select on public.sms_campaign_grades
  for select to authenticated using (auth.uid() is not null);
drop policy if exists sms_campaign_grades_service on public.sms_campaign_grades;
create policy sms_campaign_grades_service on public.sms_campaign_grades
  for all to service_role using (true) with check (true);

-- ════════════════════════════════════════════════════════════════════════════════
-- 4. sms_campaigns provenance — distinguish agent- from human-scheduled sends for
--    audit + grading, and tag the theme the agent chose.
-- ════════════════════════════════════════════════════════════════════════════════
alter table public.sms_campaigns
  add column if not exists source text not null default 'human';   -- 'human' | 'sms-agent'
alter table public.sms_campaigns
  add column if not exists agent_theme text;                        -- 'vip' | 'weekend' when source='sms-agent'
