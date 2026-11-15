/**
 * Unit tests for `isForeignSupabasePostgresMissingSpecPhasesPhaseNumAdhocNoise` — the
 * capture-time noise drop for a foreign/stale PostgREST client that selects the nonexistent
 * `spec_phases.phase_num` column against `public.spec_phases`. Built-in node:test — no
 * test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.spec-phases-phase-num-noise.test.ts
 *
 * ShopCX orders phases by `position` (stable `id` across moves) and never carried a
 * `phase_num` column on `spec_phases`; the offending read is not ShopCX code (Control Tower
 * signature `supabase-logs:49dda4a2e91c6273`). Drop AT CAPTURE only when BOTH the exact
 * `column spec_phases.phase_num does not exist` message AND the SELECT-lookup shape on
 * `spec_phases` (bare or PostgREST CTE wrapper) are present. A different column on
 * spec_phases, a different table, and a non-SELECT statement (a real write) still page.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { isForeignSupabasePostgresMissingSpecPhasesPhaseNumAdhocNoise } from "./error-feed";

test("isForeignSupabasePostgresMissingSpecPhasesPhaseNumAdhocNoise drops the captured sample (PostgREST CTE wrapper + bare SELECT on the non-existent phase_num column)", () => {
  // The captured incident shape: a stale direct-REST client lists spec_phases selecting /
  // ordering by phase_num, PostgREST wraps it as a `WITH pgrst_source AS ( SELECT ...
  // FROM "public"."spec_phases" ... )` CTE, and Postgres rejects with the column-missing.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesPhaseNumAdhocNoise(
      "column spec_phases.phase_num does not exist",
      'WITH pgrst_source AS ( SELECT "public"."spec_phases"."id", "public"."spec_phases"."phase_num" FROM "public"."spec_phases" ORDER BY "public"."spec_phases"."phase_num" ASC LIMIT $1 OFFSET $2 )',
    ),
    true,
  );
  // The `public.`-qualified message variant is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesPhaseNumAdhocNoise(
      "column public.spec_phases.phase_num does not exist",
      'with pgrst_source as ( select "public"."spec_phases"."phase_num" from "public"."spec_phases" limit 1 )',
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesPhaseNumAdhocNoise(
      "ERROR: column spec_phases.phase_num does not exist",
      'WITH pgrst_source AS ( SELECT "phase_num" FROM "public"."spec_phases" )',
    ),
    true,
  );
  // The bare SELECT form (not a PostgREST wrapper), qualified and unqualified FROM, drops.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesPhaseNumAdhocNoise(
      "column spec_phases.phase_num does not exist",
      "select id, phase_num from public.spec_phases order by phase_num asc limit 10",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesPhaseNumAdhocNoise(
      "column spec_phases.phase_num does not exist",
      "select * from spec_phases where phase_num is not null",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingSpecPhasesPhaseNumAdhocNoise KEEPS real errors (real write on spec_phases, other column, other table, non-SELECT)", () => {
  // A real INSERT / UPDATE on spec_phases with a bogus phase_num is a code bug we WANT to
  // page on — the bare-write and PostgREST-CTE-write shapes both still page.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesPhaseNumAdhocNoise(
      "column spec_phases.phase_num does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."spec_phases"("id","phase_num") VALUES ($1,$2) RETURNING * )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesPhaseNumAdhocNoise(
      "column spec_phases.phase_num does not exist",
      "update public.spec_phases set phase_num = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesPhaseNumAdhocNoise(
      "column spec_phases.phase_num does not exist",
      'insert into spec_phases (phase_num) values ($1)',
    ),
    false,
  );
  // A DIFFERENT column on spec_phases (a real column rename that broke a live query) still
  // pages — the pin is phase_num only.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesPhaseNumAdhocNoise(
      "column spec_phases.position does not exist",
      "select id, position from public.spec_phases",
    ),
    false,
  );
  // Same phase_num-missing message on a DIFFERENT relation is a real product-schema
  // regression and still pages — the pin names spec_phases only.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesPhaseNumAdhocNoise(
      "column goal_milestones.phase_num does not exist",
      "select id, phase_num from public.goal_milestones order by phase_num asc",
    ),
    false,
  );
  // A FATAL / constraint-class error on the same shape is untouched (different message).
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesPhaseNumAdhocNoise(
      "FATAL: terminating connection due to administrator command",
      "select id, phase_num from public.spec_phases",
    ),
    false,
  );
  // Empty / nullish message or query returns false — we need both markers.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesPhaseNumAdhocNoise("", "select * from spec_phases"),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesPhaseNumAdhocNoise(
      "column spec_phases.phase_num does not exist",
      "",
    ),
    false,
  );
});
