-- spec-goal-branch-pm-flow M2 — add public.spec_phases.build_sha (branch-build provenance).
-- See docs/brain/specs/spec-goal-branch-pm-flow.md §M2.
--
-- BACKGROUND. M1 moved the build lane to a branch-accumulation model: every phase of a spec commits onto ONE
-- persistent per-spec branch `claude/build-{slug}` (one commit per phase, each building on the prior phase's
-- tip), and that branch is NOT merged to main per phase. So a phase "built on the spec branch" is now a
-- distinct, earlier state than a phase "shipped to main" — and the two need separate provenance columns:
--
--   - build_sha (THIS migration) — the spec-branch commit SHA where the phase was built. Recorded by
--     stampPhaseBuilt the moment a phase's build completes on the spec branch (the worker captures
--     `git rev-parse HEAD` after the phase commit/push). The phase stays status='in_progress' (built, not
--     shipped) until promotion. This is the durable "built on the branch" signal the next-phase chaining
--     keys off (queue phase N+1 once phase N's build_sha is recorded), without a main round-trip.
--
--   - merge_sha / status='shipped' (already present, 20260713120000_specs_and_spec_phases.sql) — RESERVED for
--     the main-promotion stamp. M5 (atomic-goal-promotion-to-main) flips a build_sha'd phase to shipped with
--     the promotion merge_sha when the spec/goal branch lands on main. M2 introduces NOTHING that writes
--     status='shipped' or merge_sha from a mere branch build/commit.
--
-- The spec-level `in_testing` overlay (brain-roadmap.ts applyInTestingOverlay / readInTestingSignals) is
-- UNCHANGED — it derives built+tested at the SPEC level from {hasPreview, specTestGreen, securityGreen,
-- merged}. build_sha is per-PHASE branch provenance; it does not feed that overlay.
--
-- Nullable + idempotent (ADD COLUMN IF NOT EXISTS). No backfill: existing already-shipped phases carry
-- merge_sha; build_sha is for the branch-flow going forward. No trigger interaction — the rollup triggers
-- were dropped in 20260725160000 (status is purely read-time derived now), so this column write is inert to
-- status derivation, exactly as intended (a built phase reads in_progress, not shipped).

alter table public.spec_phases
  add column if not exists build_sha text;

comment on column public.spec_phases.build_sha is
  'spec-goal-branch-pm-flow M2 — the claude/build-{slug} spec-branch commit SHA where this phase was BUILT '
  '(stampPhaseBuilt). Distinct from merge_sha (the main-promotion stamp, set by M5 on shipped). A phase with '
  'build_sha set but no merge_sha is built-on-branch + in_progress, not shipped.';
