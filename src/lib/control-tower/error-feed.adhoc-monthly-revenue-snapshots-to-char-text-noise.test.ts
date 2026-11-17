/**
 * Unit test for the ad-hoc monthly-revenue `to_char(text, unknown)` foreign-app noise-drop
 * predicate (error-feed-drop-adhoc-monthly-revenue-snapshots-to-char-text spec). Built-in
 * node:test — no test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.adhoc-monthly-revenue-snapshots-to-char-text-noise.test.ts
 *
 * A hand-authored exploratory monthly-revenue query run in the Supabase SQL Editor calls
 * `to_char(month, 'yyyy-mm')` on a `text` column, which fails to resolve against any
 * `to_char` overload. That query is NOT ShopCX source — its `monthly_revenue_snapshots`
 * relation appears in no file under `src/` and in no migration. Drop AT CAPTURE only when
 * BOTH the exact to_char-type message AND both query fingerprints are present. A different
 * message on this query, a missing fingerprint, or an empty query/message all still page.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isForeignSupabasePostgresAdhocMonthlyRevenueSnapshotsToCharTextNoise } from "./error-feed";

// The captured production sample (Control Tower signature supabase-logs:b979de40e41e6ba2):
// the exact to_char-overload-missing message + the ad-hoc monthly-revenue query carrying
// both fingerprints.
const SAMPLE_MESSAGE = "function to_char(text, unknown) does not exist";
const SAMPLE_QUERY = `
  SELECT to_char(month,'yyyy-mm') AS ym,
         SUM(revenue) AS total
  FROM monthly_revenue_snapshots
  GROUP BY 1
  ORDER BY 1 DESC
`;

test("isForeignSupabasePostgresAdhocMonthlyRevenueSnapshotsToCharTextNoise drops the exact signature sample", () => {
  assert.equal(
    isForeignSupabasePostgresAdhocMonthlyRevenueSnapshotsToCharTextNoise(SAMPLE_MESSAGE, SAMPLE_QUERY),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresAdhocMonthlyRevenueSnapshotsToCharTextNoise(
      "ERROR: function to_char(text, unknown) does not exist",
      SAMPLE_QUERY,
    ),
    true,
  );
});

test("isForeignSupabasePostgresAdhocMonthlyRevenueSnapshotsToCharTextNoise KEEPS a different message / a missing fingerprint / empty query / empty message (real regressions still page)", () => {
  // A DIFFERENT message on the same query — the pin is this exact to_char-type message only.
  assert.equal(
    isForeignSupabasePostgresAdhocMonthlyRevenueSnapshotsToCharTextNoise(
      'relation "monthly_revenue_snapshots" does not exist',
      SAMPLE_QUERY,
    ),
    false,
  );
  // The same to_char-type error from a query MISSING a fingerprint (e.g. our own product
  // code with a genuine to_char type bug) — still pages.
  assert.equal(
    isForeignSupabasePostgresAdhocMonthlyRevenueSnapshotsToCharTextNoise(
      SAMPLE_MESSAGE,
      "select to_char(created_at,'yyyy-mm') as ym from orders",
    ),
    false,
  );
  // Empty query attribute — cannot confirm the fingerprints, still pages.
  assert.equal(
    isForeignSupabasePostgresAdhocMonthlyRevenueSnapshotsToCharTextNoise(SAMPLE_MESSAGE, ""),
    false,
  );
  // Empty message — still pages.
  assert.equal(
    isForeignSupabasePostgresAdhocMonthlyRevenueSnapshotsToCharTextNoise("", SAMPLE_QUERY),
    false,
  );
});
