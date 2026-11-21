/**
 * Unit tests for `isForeignSupabasePostgresMissingSpecPhaseChecksDirectRestColumnNoise` — the
 * capture-time noise-drop for a foreign/stale direct-REST client SELECTing the never-existed
 * `check_type` / `config` / `status` columns from `public.spec_phase_checks` (Control Tower
 * signature `supabase-logs:48783ba83e25f93f`). Built-in node:test — no test-runner dependency.
 * Run:
 *   npx tsx --test src/lib/control-tower/error-feed.spec-phase-checks-noise.test.ts
 *
 * The predicate must DROP the captured production sample on both the bare-SELECT and the
 * PostgREST-CTE wrapper shapes, and KEEP (page on) a real missing column on a live
 * `spec_phase_checks` column, the same check_type/config/status message on a different
 * relation, and a non-SELECT statement on `spec_phase_checks`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isForeignSupabasePostgresMissingSpecPhaseChecksDirectRestColumnNoise } from "./error-feed";

test("drops the bare SELECT direct-REST read of the never-existed spec_phase_checks.check_type column", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhaseChecksDirectRestColumnNoise(
      "column spec_phase_checks.check_type does not exist",
      "select id, check_type from public.spec_phase_checks where phase_id = $1",
    ),
    true,
  );
  // Leading `ERROR: ` prefix Postgres includes on the logs surface is stripped.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhaseChecksDirectRestColumnNoise(
      "ERROR: column public.spec_phase_checks.check_type does not exist",
      "SELECT check_type FROM spec_phase_checks LIMIT 1",
    ),
    true,
  );
});

test("drops the bare SELECT direct-REST read of the never-existed config / status columns", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhaseChecksDirectRestColumnNoise(
      "column spec_phase_checks.config does not exist",
      "select id, config from public.spec_phase_checks order by created_at desc",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhaseChecksDirectRestColumnNoise(
      "column public.spec_phase_checks.status does not exist",
      "select status from spec_phase_checks",
    ),
    true,
  );
});

test("drops the PostgREST CTE wrapper lookup projecting the never-existed check_type/config/status columns", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhaseChecksDirectRestColumnNoise(
      "column spec_phase_checks.check_type does not exist",
      'WITH pgrst_source AS ( SELECT "public"."spec_phase_checks"."check_type" FROM "public"."spec_phase_checks" ) SELECT * FROM pgrst_source',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhaseChecksDirectRestColumnNoise(
      "column spec_phase_checks.status does not exist",
      'with pgrst_source as ( select "public"."spec_phase_checks"."status" from "public"."spec_phase_checks" where "public"."spec_phase_checks"."id" = $1 ) select * from pgrst_source',
    ),
    true,
  );
});

test("KEEPS a real missing column on a live spec_phase_checks column (a genuine schema regression still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhaseChecksDirectRestColumnNoise(
      "column spec_phase_checks.kind does not exist",
      "select id, kind from public.spec_phase_checks where phase_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhaseChecksDirectRestColumnNoise(
      "column spec_phase_checks.phase_id does not exist",
      "select phase_id from spec_phase_checks",
    ),
    false,
  );
});

test("KEEPS the same check_type/config/status message on a DIFFERENT relation (a real product-schema regression still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhaseChecksDirectRestColumnNoise(
      "column spec_phases.status does not exist",
      "select status from public.spec_phases",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhaseChecksDirectRestColumnNoise(
      "column recipes.config does not exist",
      "select config from public.recipes",
    ),
    false,
  );
});

test("KEEPS a non-SELECT statement on spec_phase_checks (a real code-bug write still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhaseChecksDirectRestColumnNoise(
      "column spec_phase_checks.check_type does not exist",
      "update public.spec_phase_checks set check_type = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhaseChecksDirectRestColumnNoise(
      "column spec_phase_checks.config does not exist",
      "insert into public.spec_phase_checks (config) values ($1)",
    ),
    false,
  );
  // PostgREST CTE wrapper around a non-SELECT op stays captured / pages.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhaseChecksDirectRestColumnNoise(
      "column spec_phase_checks.status does not exist",
      'with pgrst_source as ( update "public"."spec_phase_checks" set "status" = $1 ) select * from pgrst_source',
    ),
    false,
  );
});

test("KEEPS a FATAL / constraint error on the spec_phase_checks SELECT shape (a different Postgres error still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhaseChecksDirectRestColumnNoise(
      "FATAL: terminating connection due to administrator command",
      "select check_type from public.spec_phase_checks",
    ),
    false,
  );
});

test("returns false on empty / nullish input", () => {
  assert.equal(isForeignSupabasePostgresMissingSpecPhaseChecksDirectRestColumnNoise(null, null), false);
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhaseChecksDirectRestColumnNoise(undefined, undefined),
    false,
  );
  assert.equal(isForeignSupabasePostgresMissingSpecPhaseChecksDirectRestColumnNoise("", ""), false);
  // Message matches but the query is empty — we need both markers.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhaseChecksDirectRestColumnNoise(
      "column spec_phase_checks.check_type does not exist",
      "",
    ),
    false,
  );
});
