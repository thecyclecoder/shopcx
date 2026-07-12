-- machine-declared-verification-and-deterministic-spec-test-runner Phase 1 — executable check payload.
-- See docs/brain/specs/machine-declared-verification-and-deterministic-spec-test-runner.md § Phase 1.
--
-- Extends `public.spec_phase_checks` (pm-structured-intent-and-refs Phase 3) with a TYPED, EXECUTABLE
-- payload so a deterministic Node runner (Phase 2) can VERIFY the auto-testable subset with no LLM:
--
--   - `exec_kind` — the runnable kind: 'tsc' | 'grep' | 'ci_status' | 'http_get' | 'db_probe_readonly' |
--     'unit_test' | 'build' | 'needs_human'. Coexists with the coarse `kind` ('auto' | 'human') during
--     the migration window; `kind` stays authoritative for display/chip category and the runner reads
--     `exec_kind` to decide execution. `needs_human` = never auto-run (drift / subjective / prose).
--   - `params` — the typed jsonb per exec_kind. Shape is validator-enforced in the app layer
--     (`validateExecutableCheck` — src/lib/spec-phase-checks-table.ts):
--       grep               → { pattern: string, path?: string, expect: 'present'|'absent' }
--       http_get           → { url: string, expect_status: number }
--       db_probe_readonly  → { sql: <plain SELECT>, expect: unknown }
--       unit_test          → { script: <a real package.json script> }
--       tsc / build        → null (no params)
--       needs_human        → null (never auto-run)
--
-- Additive by design: both columns are nullable so existing rows keep working (row-level default
-- `exec_kind='needs_human'` is enforced at write time by parseVerificationBlobToChecks — nothing
-- auto-runs on undeclared prose, the safe default). New authoring writes both columns.

alter table public.spec_phase_checks
  add column if not exists exec_kind text
    check (
      exec_kind is null
      or exec_kind in (
        'tsc',
        'grep',
        'ci_status',
        'http_get',
        'db_probe_readonly',
        'unit_test',
        'build',
        'needs_human'
      )
    );

alter table public.spec_phase_checks
  add column if not exists params jsonb;

comment on column public.spec_phase_checks.exec_kind is
  'machine-declared-verification Phase 1 — executable kind read by the deterministic spec-check runner: '
  'tsc | grep | ci_status | http_get | db_probe_readonly | unit_test | build | needs_human. Coexists with '
  'the coarse `kind` column during the migration window; needs_human never auto-runs.';
comment on column public.spec_phase_checks.params is
  'machine-declared-verification Phase 1 — typed params jsonb per exec_kind; shape enforced app-layer '
  'by validateExecutableCheck (src/lib/spec-phase-checks-table.ts).';
