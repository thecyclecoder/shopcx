-- pm-structured-intent-and-refs Phase 1 — the SHARED intent layer across the PM tree.
-- See docs/brain/specs/pm-structured-intent-and-refs.md § Phase 1.
--
-- Every level of the PM tree (goals / goal_milestones / specs / spec_phases) needs a plain-language,
-- human-first `why` (why this node exists) + `what` (what changes when it's done) — the intent both a
-- human reader and the authoring/build agents share. Today the DB carries builder-agent implementation
-- instructions (spec/phase `body`, milestone `body`) but never the intent, so the detail page reads as a
-- wall of jargon. This migration adds the intent columns; the app layer (author-spec + goal-proposals)
-- gates them non-empty at authoring time — same style as `MissingVerificationError` (a spec whose intent
-- isn't captured never lands).
--
-- Reconcile, don't duplicate:
--  - goals ALREADY carry `outcome` (the one-line "what changes when this goal ships") + `success_metric`
--    (the measurable target). goals.outcome IS the goal's WHAT — we do NOT add a `goals.what` column and
--    have the app layer treat `goals.outcome` as the what. We add `goals.why` — new; the goal's motivation.
--  - goal_milestones / specs / spec_phases have no existing intent columns, so both `why` + `what` are new.
--
-- Nullable (no backfill lives inside a migration — pre-existing rows carry NULL until re-authored). The
-- app-layer gate enforces non-empty at authoring time going forward; the CI + brain-page updates land in
-- Phase 5.

alter table public.goals
  add column if not exists why text;

alter table public.goal_milestones
  add column if not exists why text,
  add column if not exists what text;

alter table public.specs
  add column if not exists why text,
  add column if not exists what text;

alter table public.spec_phases
  add column if not exists why text,
  add column if not exists what text;

comment on column public.goals.why is
  'pm-structured-intent-and-refs Phase 1 — plain-language WHY this goal exists (the motivation the CEO + '
  'directors + humans + agents share). Paired with the existing goals.outcome column (the WHAT — kept, not '
  'duplicated). The board detail page leads with why + outcome; the technical body sits behind a toggle. '
  'App-layer gate: authoring paths (goal-proposals proposeGoal) require this non-empty going forward.';

comment on column public.goal_milestones.why is
  'pm-structured-intent-and-refs Phase 1 — plain-language WHY this milestone exists inside its goal. '
  'Paired with `what`. The board detail page renders (why + what) per milestone; the free-text `body` '
  'is display detail only.';

comment on column public.goal_milestones.what is
  'pm-structured-intent-and-refs Phase 1 — plain-language WHAT changes when this milestone lands. Paired '
  'with `why`. Distinct from the free-text `body` which carries implementation notes for downstream agents.';

comment on column public.specs.why is
  'pm-structured-intent-and-refs Phase 1 — plain-language WHY this spec exists. Paired with `what`. HARD '
  'gate at the app-layer chokepoint (author-spec.authorSpecRowStructured) — a spec authored with empty '
  'why/what throws MissingIntentError before the DB write, mirroring MissingVerificationError. The plain '
  'intent LEADS the detail page; the phase bodies carry the technical implementation.';

comment on column public.specs.what is
  'pm-structured-intent-and-refs Phase 1 — plain-language WHAT changes when this spec ships. Paired with '
  '`why`. HARD gate at the app-layer chokepoint. Distinct from `summary` (a longer paragraph) — this is '
  'the one-line "when this ships, X changes" that both humans + agents read.';

comment on column public.spec_phases.why is
  'pm-structured-intent-and-refs Phase 1 — plain-language WHY this phase exists inside its spec. Paired '
  'with `what`. HARD gate at the app-layer chokepoint (per-phase, mirrors the verification gate).';

comment on column public.spec_phases.what is
  'pm-structured-intent-and-refs Phase 1 — plain-language WHAT changes when this phase ships. Paired '
  'with `why`. HARD gate at the app-layer chokepoint.';
