/**
 * Unit tests for `isForeignSupabasePostgresMissingPlaybooksStepsDirectRestColumnNoise` — the
 * capture-time noise-drop for a foreign/stale direct-REST client SELECTing the non-existent
 * `steps` / `config` columns from `public.playbooks` (Control Tower signature
 * `supabase-logs:c19182e4043d30c3`). Built-in node:test — no test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.playbooks-steps-noise.test.ts
 *
 * The predicate must DROP the captured production sample on both the bare-SELECT and the
 * PostgREST-CTE wrapper shapes, and KEEP (page on) a real missing column on a live
 * `playbooks` column, the same `steps`/`config` message on a different relation, and a
 * non-SELECT statement on `playbooks`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isForeignSupabasePostgresMissingPlaybooksStepsDirectRestColumnNoise } from "./error-feed";

test("drops the bare SELECT direct-REST read of the non-existent playbooks.steps column", () => {
  assert.equal(
    isForeignSupabasePostgresMissingPlaybooksStepsDirectRestColumnNoise(
      "column playbooks.steps does not exist",
      "select id, steps from public.playbooks where workspace_id = $1",
    ),
    true,
  );
  // Leading `ERROR: ` prefix Postgres includes on the logs surface is stripped.
  assert.equal(
    isForeignSupabasePostgresMissingPlaybooksStepsDirectRestColumnNoise(
      "ERROR: column public.playbooks.steps does not exist",
      "SELECT steps FROM playbooks LIMIT 1",
    ),
    true,
  );
});

test("drops the bare SELECT direct-REST read of the non-existent playbooks.config column", () => {
  assert.equal(
    isForeignSupabasePostgresMissingPlaybooksStepsDirectRestColumnNoise(
      "column playbooks.config does not exist",
      "select id, config from public.playbooks order by created_at desc",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingPlaybooksStepsDirectRestColumnNoise(
      "column public.playbooks.config does not exist",
      "select config from playbooks",
    ),
    true,
  );
});

test("drops the PostgREST CTE wrapper lookup projecting the non-existent steps/config columns", () => {
  assert.equal(
    isForeignSupabasePostgresMissingPlaybooksStepsDirectRestColumnNoise(
      "column playbooks.steps does not exist",
      'WITH pgrst_source AS ( SELECT "public"."playbooks"."steps" FROM "public"."playbooks" ) SELECT * FROM pgrst_source',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingPlaybooksStepsDirectRestColumnNoise(
      "column playbooks.config does not exist",
      'with pgrst_source as ( select "public"."playbooks"."config" from "public"."playbooks" where "public"."playbooks"."id" = $1 ) select * from pgrst_source',
    ),
    true,
  );
});

test("KEEPS a real missing column on a live playbooks column (a genuine schema regression still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingPlaybooksStepsDirectRestColumnNoise(
      "column playbooks.title does not exist",
      "select id, title from public.playbooks where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingPlaybooksStepsDirectRestColumnNoise(
      "column playbooks.enabled does not exist",
      "select enabled from playbooks",
    ),
    false,
  );
});

test("KEEPS the same steps/config message on a DIFFERENT relation (a real product-schema regression still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingPlaybooksStepsDirectRestColumnNoise(
      "column journey_definitions.steps does not exist",
      "select steps from public.journey_definitions",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingPlaybooksStepsDirectRestColumnNoise(
      "column recipes.config does not exist",
      "select config from public.recipes",
    ),
    false,
  );
});

test("KEEPS a non-SELECT statement on playbooks (a real code-bug write still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingPlaybooksStepsDirectRestColumnNoise(
      "column playbooks.steps does not exist",
      "update public.playbooks set steps = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingPlaybooksStepsDirectRestColumnNoise(
      "column playbooks.config does not exist",
      "insert into public.playbooks (config) values ($1)",
    ),
    false,
  );
  // PostgREST CTE wrapper around a non-SELECT op stays captured / pages.
  assert.equal(
    isForeignSupabasePostgresMissingPlaybooksStepsDirectRestColumnNoise(
      "column playbooks.steps does not exist",
      'with pgrst_source as ( update "public"."playbooks" set "steps" = $1 ) select * from pgrst_source',
    ),
    false,
  );
});

test("KEEPS a FATAL / constraint error on the playbooks SELECT shape (a different Postgres error still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingPlaybooksStepsDirectRestColumnNoise(
      "FATAL: terminating connection due to administrator command",
      "select steps from public.playbooks",
    ),
    false,
  );
});

test("returns false on empty / nullish input", () => {
  assert.equal(isForeignSupabasePostgresMissingPlaybooksStepsDirectRestColumnNoise(null, null), false);
  assert.equal(
    isForeignSupabasePostgresMissingPlaybooksStepsDirectRestColumnNoise(undefined, undefined),
    false,
  );
  assert.equal(isForeignSupabasePostgresMissingPlaybooksStepsDirectRestColumnNoise("", ""), false);
  // Message matches but the query is empty — we need both markers.
  assert.equal(
    isForeignSupabasePostgresMissingPlaybooksStepsDirectRestColumnNoise(
      "column playbooks.steps does not exist",
      "",
    ),
    false,
  );
});
