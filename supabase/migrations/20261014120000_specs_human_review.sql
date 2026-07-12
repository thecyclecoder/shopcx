-- every-spec-writer-authors-machine-runnable-verifications Phase 2 — add the OPTIONAL, non-blocking
-- `human_review` column to public.specs.
--
-- Purpose: the CEO decision (2026-07-11) demoted human/subjective tests from a BLOCKING gate to an
-- advisory founder-facing note. Machine-runnable checks (spec_phase_checks with a valid exec_kind)
-- are the ONLY ship gate; `human_review` carries the eyeball prompt ("after ship, open /dashboard/x
-- and confirm the layout reads right") that renders on the spec card + post-ship founder surface but
-- is NEVER read by the fold gate, the promote gate, or the deterministic spec-check runner.
--
-- Additive + nullable + no default so a legacy row silently reads NULL (advisory-absent is the norm);
-- an author who wants an eyeball note passes it through `authorSpecRowStructured` and the SDK persists.

alter table public.specs
  add column if not exists human_review text;

comment on column public.specs.human_review is
  'every-spec-writer-authors-machine-runnable-verifications Phase 2 — optional, non-blocking founder-facing advisory note. NEVER read by fold/promote/spec-check-runner gates (machine checks are the ship gate). Rendered on the spec card + post-ship founder surface. Absence is fine.';
