-- vale-reasons-the-disposition Phase 1 — Vale emits + the worker stores a reasoned disposition on a PASS.
--
-- Today Vale (spec-review) emits QUALITY ONLY (pass/needs_fix) and Ada's disposition sweep applies
-- `adaDispositionFor` — a TRUST-THE-AUTHOR stub that returns the author's `intended_status` unchanged.
-- So a spec's build-now-vs-defer decision is currently a rubber-stamp. This spec upgrades the review pass:
-- Vale already reads the entire spec for quality, so she ALSO emits a reasoned planned/deferred
-- recommendation at ~zero extra cost ('hydrate once, extra verdict free'). Phase 1 adds the DB slots the
-- worker stores that recommendation in; Phase 2 (a follow-up) wires the sweep to consume it.
--
-- Columns:
--  - vale_disposition        text CHECK ('planned' | 'deferred' | NULL) — Vale's recommendation on a PASS
--                                                                        (NULL on needs_fix; NULL on an
--                                                                        old-style pre-migration pass →
--                                                                        the sweep falls back to
--                                                                        intended_status).
--  - vale_disposition_reason text — the plain-text WHY for the recommendation (audit + shown to CEO on
--                                   Ada's asymmetric routing — UPGRADE Approval Request / DOWNGRADE
--                                   notification carry THIS reason, not a stub reason).
--
-- Both columns clear alongside `vale_pass` on a send-back / re-author (markSpecCardBackToReview) so a
-- materially-changed spec must be re-reviewed and re-disposed.

alter table public.specs
  add column if not exists vale_disposition text
    check (vale_disposition in ('planned', 'deferred'));

alter table public.specs
  add column if not exists vale_disposition_reason text;

comment on column public.specs.vale_disposition is
  'vale-reasons-the-disposition Phase 1: Vale''s reasoned planned/deferred recommendation on a PASS '
  'verdict. Ada''s disposition sweep (adaDispositionFor) consumes it in Phase 2 (retiring the '
  'trust-the-author stub); Phase 1 populates the column only. NULL on needs_fix (an ill-formed spec is '
  'not dispositionable yet). NULL on a pass authored BEFORE this column existed — the sweep falls back '
  'to intended_status so the migration is graceful.';

comment on column public.specs.vale_disposition_reason is
  'vale-reasons-the-disposition Phase 1: the plain-text WHY behind Vale''s vale_disposition recommendation. '
  'Ada''s asymmetric routing surfaces this reason on the CEO Approval Request (UPGRADE) / CEO notification '
  '(DOWNGRADE) — the CEO reads the SAME reason Vale wrote. Cleared with vale_disposition.';
