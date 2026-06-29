# Writing no-op pipeline validation specs

When validating the PM pipeline itself — the build system, phase accumulation, migration gating, fold logic — write a no-op spec that exercises the full pipeline without side-effects. These are test specs with ZERO production impact, useful for:

- Validating new pipeline features (Ada's build infrastructure improvements)
- Exercising the end-to-end flow without risk (spec branch → goal branch → main → fold)
- Testing migration-approval gates, Vale review, phase accumulation, and promotion logic
- End-to-end CI validation of the spec system itself

## Pattern

A no-op validation spec has these properties:

1. **Owner: Platform/Eng** ([[../functions/platform]]) — these are build-system tests
2. **Parent: Platform mandate** (e.g., "Autonomous build platform") — perpetual charter, no goal
3. **Unused artifacts** — every phase ships code/schema that is verifiably NEVER read or written elsewhere
4. **Explicit verification** — grep confirms zero readers/writers; tsc confirms it compiles
5. **No business value** — the test IS the value (validating the pipeline itself)

## Example: marker constant (Phase 1)

```ts
// src/lib/_noop-pipeline-test-4.ts
export const NOOP_PIPELINE_TEST_MARKER_4 = "noop-pipeline-test-4" as const;
```

- Unused export: tsc compiles it, nothing imports it
- Verification: `grep NOOP_PIPELINE_TEST_MARKER_4 → exactly one definition, zero readers`
- Exercises: the P1 build lane, artifact shipping, no PR side-effect

## Example: nullable migration (Phase 2)

```sql
-- supabase/migrations/YYYYMMDDNNNNNN_noop_pipeline_test_4.sql
alter table public.director_activity add column if not exists _noop_pipeline_test_4 text;
```

- Additive, nullable, unused: no backfill, no reader/writer code
- Verification: `probe public.director_activity → column exists + all NULL + zero writes`
- Exercises: migration gating (Ada approves script), phase accumulation, resume-stamp flow

## When to use

Write a no-op validation spec when:

- Testing a new PM pipeline feature (e.g., a new promotion gate, a new status derivation, a gated approval step)
- Validating phase accumulation before shipping a production spec
- Testing the fold logic or spec-branch integration
- Isolating an end-to-end flow you want to instrument with new observability

Don't use for:

- Regular feature specs (those should have real business value)
- Debugging a broken spec (fix the spec / pipeline, don't add test specs)
- One-off validation that's not repeatable (that's manual QA, not a pipeline test)

## Related

[[../project-management]] — PM flow + spec states · [[../lifecycles/spec-goal-branch-pm-flow]] — phase accumulation + promotion · [[../tables/specs]] — spec table schema + status columns
