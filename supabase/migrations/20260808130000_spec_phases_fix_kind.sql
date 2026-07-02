-- fixes-as-phases ([[../../docs/brain/libraries/pre-merge-fix]]): a pre-merge spec-test regression no
-- longer authors a separate fix-<slug> spec. Instead the failing checks are appended to the ORIGIN
-- spec's spec_phases as kind='fix' phases, flipping the spec back to in-progress; the existing
-- chained-phase build + accumulation machinery builds them one-at-a-time (resume session) and
-- re-spec-tests on completion (self-heal). These columns mark a phase's kind + which failing check
-- keys a fix phase addresses (so re-verification maps a fix back to the checks it resolves).
--
-- Idempotent (ADD COLUMN IF NOT EXISTS; existing rows default to kind='phase').

alter table public.spec_phases
  add column if not exists kind text not null default 'phase',
  add column if not exists origin_check_keys text[] not null default '{}';

comment on column public.spec_phases.kind is
  'phase | fix — a fix phase is appended by the pre-merge-fix flow when a spec-test regression is found (fixes-as-phases). Reuses the phase build/resume/accumulation machinery; builds one-at-a-time, own commit, resumes the origin session.';
comment on column public.spec_phases.origin_check_keys is
  'For kind=fix phases: the spec_test check_key(s) this fix addresses, so re-verification maps the fix back to its failing checks. Empty for normal phases.';
