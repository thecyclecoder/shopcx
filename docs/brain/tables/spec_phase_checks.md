# spec_phase_checks

ONE ROW PER VERIFICATION CHECK on a spec phase ([[../specs/pm-structured-intent-and-refs]] Phase 3). Replaces the free-text `spec_phases.verification` blob with `{position, description, kind}` rows; [[../specs/machine-declared-verification-and-deterministic-spec-test-runner]] Phase 1 extends each row with an executable payload (`exec_kind` + `params`) so the deterministic spec-check runner (Phase 2) executes the auto-testable subset with no LLM.

**Workspace-scoped via the parent** (inherited from `specs.workspace_id` via `spec_phases`). RLS: authenticated reads; service-role full access.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `phase_id` | `uuid` | FK → `spec_phases(id)` on delete cascade |
| `position` | `int` | 1-indexed ordering within the phase. Unique per `(phase_id, position)` |
| `description` | `text` | the plain-language "- On {where}, {do what} → expect {observable result}" line |
| `kind` | `text` | `auto` (spec-test agent runs directly, non-destructive) or `human` (parked needs_human). CHECK-constrained · default `auto` |
| `exec_kind` | `text` | executable check kind ([[../specs/machine-declared-verification-and-deterministic-spec-test-runner]] Phase 1): `tsc` \| `grep` \| `ci_status` \| `http_get` \| `db_probe_readonly` \| `unit_test` \| `build` \| `needs_human`. NULL or `needs_human` = never auto-run. Read by [[../libraries/spec-check-runner]] `runSpecChecks`. |
| `params` | `jsonb` | typed executable params per `exec_kind` (shape validated in app layer by [[../libraries/spec-phase-checks-table]] `validateExecutableCheck`). Null for `tsc`/`build`/`needs_human`. |
| `created_at` | `timestamptz` | default `now()` |
| `updated_at` | `timestamptz` | default `now()` |

## Upsert spine

`spec_phase_checks_phase_position` — unique on `(phase_id, position)`. The SDK writer [[../libraries/spec-phase-checks-table]] `upsertPhaseChecks(phase_id, checks[])` REPLACES the set by position — matching positions UPDATE in place (stable id), new positions INSERT, vanished positions DELETE.

## Author chokepoint gate

[[../libraries/author-spec]] `assertEveryPhaseHasChecks` throws `MissingVerificationError` if any phase yields zero checks (whether from an explicit `checks[]` array or from the derived split of the `verification` text). Runs BEFORE the DB write — an untestable phase never lands.

## Migration

- `supabase/migrations/20260807160000_pm_spec_phase_checks.sql` ([[../specs/pm-structured-intent-and-refs]] Phase 3) — creates the table · apply: `scripts/apply-pm-spec-phase-checks-migration.ts`

## Related

[[spec_phases]] · [[../libraries/spec-phase-checks-table]] · [[../libraries/author-spec]] · [[../specs/pm-structured-intent-and-refs]] · [[../specs/machine-declared-verification-and-deterministic-spec-test-runner]]
