-- Review-request rubric + drafts persistence (Phase 2 of review-request-sol-session).
--
-- The whole program's value is in the MESSAGE. A spec that says "write a good
-- email" guarantees nothing; a rubric baked into a prompt string can't be
-- tuned on evidence. So we split responsibilities two ways:
--
--   1. `review_message_rubrics` — the rubric is DATA. 8 criteria, 100 points,
--      floor 75, mirroring the dahlia-copy-author pattern. Versioned per
--      workspace so an evidence-driven tune (Phase-2 grader sweep correlating
--      real response rates against rubric scores) can flip in a new version
--      without a code change. Read at compose time by
--      `getActiveReviewRubric` (src/lib/review-message-rubric.ts) and rendered
--      into Sol's self-scoring prompt; the QC session reads the same rubric.
--
--   2. `review_message_drafts` — every draft persists with its rubric score,
--      QC verdict, and eventual outcome. That is what later grader sweeps
--      read to tune the rubric on evidence instead of taste.
--
-- Both tables are RLS-scoped (member read, service-role write) — same shape
-- as [[review_requests]] from the foundations migration.
--
-- Additive + idempotent — no DROP; the repo's reversible-by-default rail
-- (scripts/_check-no-hard-destructive-migrations.ts) runs in predeploy.

-- 1. review_message_rubrics ─────────────────────────────────────────────────
create table if not exists public.review_message_rubrics (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- Version starts at 1; the grader-driven tune bumps this per-workspace when a
  -- new rubric replaces the active one. A version_bump does NOT edit an older
  -- row (the draft table's `rubric_version` snapshot must stay honest).
  version integer not null,
  -- The rubric ITSELF — 8 criteria, each with a name / weight (integer points)
  -- / a short instruction the self-scoring + QC prompt renders verbatim. Jsonb
  -- because the criteria are DATA the grader tunes, not code.
  criteria jsonb not null,
  -- The floor a draft's self-score must clear to send. 75 is the initial
  -- number the spec pins (dahlia-copy-author parity); the grader tune can
  -- move it.
  floor integer not null default 75,
  -- Only one row per workspace is `is_active = true` at a time. The compose
  -- loader picks that row; a version bump flips the prior row to false in the
  -- same transaction.
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.review_message_rubrics is
  'Versioned per-workspace rubric for Sol''s review-request message self-score '
  '+ independent QC pass. 8 criteria / 100 points / floor 75 (initial). Data, '
  'not a prompt string — the grader sweep tunes weights on evidence. See '
  '[[docs/brain/tables/review_message_rubrics]].';

create unique index if not exists review_message_rubrics_workspace_version_uniq
  on public.review_message_rubrics (workspace_id, version);

create unique index if not exists review_message_rubrics_active_uniq
  on public.review_message_rubrics (workspace_id)
  where is_active = true;

create or replace function public.review_message_rubrics_touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists review_message_rubrics_touch_updated_at on public.review_message_rubrics;
create trigger review_message_rubrics_touch_updated_at
  before update on public.review_message_rubrics
  for each row execute function public.review_message_rubrics_touch_updated_at();

alter table public.review_message_rubrics enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'review_message_rubrics'
      and policyname = 'review_message_rubrics_member_read'
  ) then
    create policy review_message_rubrics_member_read on public.review_message_rubrics for select to authenticated
      using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
  end if;
  if not exists (
    select 1 from pg_policies
    where tablename = 'review_message_rubrics'
      and policyname = 'review_message_rubrics_service_role'
  ) then
    create policy review_message_rubrics_service_role on public.review_message_rubrics for all
      using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
end $$;

-- Seed the initial v1 rubric for EVERY existing workspace so the compose
-- loader has a row to read on day one. The 8 criteria + weights are the exact
-- shape the spec pins (Phase 2 § "The rubric (versioned, in the DB)"). Notes
-- carry the plain-language "how to score" the self-score + QC prompt reads
-- verbatim so the whole rubric truly is data, not a prompt string.
insert into public.review_message_rubrics (workspace_id, version, criteria, floor, is_active, notes)
select w.id, 1,
  jsonb_build_array(
    jsonb_build_object('key','ask_is_question','weight',15,'instruction','The ask reads as a question the customer is invited to answer, not a chore they''re assigned.'),
    jsonb_build_object('key','named_person_position','weight',15,'instruction','A named person with a concrete position writes the message (not "the team" / "Superfoods").'),
    jsonb_build_object('key','status_reversal','weight',15,'instruction','Status reversal — we need help, they are the authority. Not "would you review us?" but "we need people considering us to hear from you."'),
    jsonb_build_object('key','founder_plain_voice','weight',15,'instruction','Founder-plain voice — no marketing lift, no exclamation stacking, no "Hi there {name}!" greeting.'),
    jsonb_build_object('key','earned_identity_priming','weight',10,'instruction','Identity priming that is earned by the customer''s real history — "as a two-year customer" only when tenure warrants it. Never a bare flatter.'),
    jsonb_build_object('key','fact_in_first_two_lines','weight',10,'instruction','The hand-picked fact (tenure, product, order count) lands in the first two lines. Otherwise the customer decides whether to read the ask before seeing why we picked them.'),
    jsonb_build_object('key','time_cost_no_friction','weight',10,'instruction','Time cost is stated ("about a minute") and no friction is added (no sign-in, no long form up front).'),
    jsonb_build_object('key','continuity_with_thread','weight',10,'instruction','Continuity with what actually happened in the ticket — the message reads as coming from the same person the customer just spoke to, not a marketing hand-off.')
  ),
  75, true,
  'Initial v1 rubric — 8 criteria / 100 points / floor 75. Tune with evidence via a version bump; the older rows stay for provenance.'
from public.workspaces w
where not exists (
  select 1 from public.review_message_rubrics r
  where r.workspace_id = w.id and r.version = 1
);

-- 2. review_message_drafts ──────────────────────────────────────────────────
create table if not exists public.review_message_drafts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  -- The ticket the goodwill came from — the review-candidacy detector cron
  -- anchors on this. Null iff the draft was authored out-of-band (a hand-picked
  -- one-off, not the ladder). Set-null on ticket delete so a purged ticket
  -- doesn't cascade over a draft the grader still needs.
  ticket_id uuid references public.tickets(id) on delete set null,
  -- The review_requests row the ladder minted for this ask (created when the
  -- send actually happens). Null while the draft is still pre-send. Set-null
  -- on delete so a purged ask doesn't cascade over a draft.
  review_request_id uuid references public.review_requests(id) on delete set null,
  -- 'email' | 'sms' — mirrors review_requests.channel; text so the ladder can
  -- add channels without a migration.
  channel text not null,
  -- 'defend' | 'fence-sitter' — mirrors the spec's two angles. Text (not enum)
  -- so a future angle doesn't need a migration.
  angle text not null,
  subject text,
  body text not null,
  -- The rubric this draft was scored against (workspace_id + version pair).
  -- Version is captured as an integer so a later grader sweep can reconcile
  -- scores against the exact rubric a draft was authored under, even after a
  -- version bump.
  rubric_version integer,
  -- Sol''s self-scoring output — jsonb because the criteria set is versioned;
  -- shape { total: int, per_criterion: { <key>: int }, revision_count: int }.
  self_score jsonb,
  -- Independent-QC verdict — the SECOND session that did not write the draft.
  -- Jsonb because a fail carries a reason bag. Shape
  -- { verdict: 'pass'|'fail', reasons: string[], reasoning: string }.
  qc_verdict jsonb,
  -- The pre-send validator's verdict (deterministic hard-block, sibling of
  -- the predeploy `_check-*.ts` rails). Shape
  -- { allow: bool, reasons: string[] }. A drafted row with `allow=false` is
  -- persisted for provenance but NEVER sent.
  validator_verdict jsonb,
  -- Lifecycle marker — 'drafted' → 'validated' → 'sent' → 'clicked' →
  -- 'submitted' | 'skipped' | 'expired'. Text so the ladder can add outcomes
  -- without a migration; readers probe actual values (CLAUDE.md § "Database
  -- is the spec").
  outcome text not null default 'drafted',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.review_message_drafts is
  'One row per drafted review-request message. Persists every draft with its '
  'rubric self-score, independent-QC verdict, deterministic-validator verdict, '
  'and eventual outcome so a later grader sweep can correlate rubric scores '
  'against real response rates and tune the rubric on evidence. See '
  '[[docs/brain/tables/review_message_drafts]].';

create index if not exists review_message_drafts_workspace_customer_idx
  on public.review_message_drafts (workspace_id, customer_id, created_at desc);

create index if not exists review_message_drafts_ticket_idx
  on public.review_message_drafts (ticket_id) where ticket_id is not null;

create index if not exists review_message_drafts_review_request_idx
  on public.review_message_drafts (review_request_id) where review_request_id is not null;

create index if not exists review_message_drafts_outcome_idx
  on public.review_message_drafts (workspace_id, outcome, created_at desc);

create or replace function public.review_message_drafts_touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists review_message_drafts_touch_updated_at on public.review_message_drafts;
create trigger review_message_drafts_touch_updated_at
  before update on public.review_message_drafts
  for each row execute function public.review_message_drafts_touch_updated_at();

alter table public.review_message_drafts enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'review_message_drafts'
      and policyname = 'review_message_drafts_member_read'
  ) then
    create policy review_message_drafts_member_read on public.review_message_drafts for select to authenticated
      using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
  end if;
  if not exists (
    select 1 from pg_policies
    where tablename = 'review_message_drafts'
      and policyname = 'review_message_drafts_service_role'
  ) then
    create policy review_message_drafts_service_role on public.review_message_drafts for all
      using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
end $$;
