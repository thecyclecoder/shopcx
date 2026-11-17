/**
 * Unit test for the ad-hoc SKU-sales `round(double precision, integer)` foreign-app
 * noise-drop predicate (error-feed-drop-adhoc-sku-sales-round-type-noise spec). Built-in
 * node:test — no test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.adhoc-sku-sales-round-type-noise.test.ts
 *
 * A hand-authored exploratory SKU-sales analysis query run in the Supabase SQL Editor calls
 * `round(<double precision>, 2)`, which fails to resolve against the only two-arg overload
 * `round(numeric, integer)`. That query is NOT ShopCX source — its aliases `net_per_unit` /
 * `med_price` and its `percentile_cont(0.5) within group (order by p)` median expression
 * appear in no file under `src/`. Drop AT CAPTURE only when BOTH the exact round-type
 * message AND all three query fingerprints are present. A different message on this query, a
 * missing fingerprint, or an empty query/message all still page.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isForeignSupabasePostgresAdhocSkuSalesRoundTypeNoise } from "./error-feed";

// The captured production sample (Control Tower signature supabase-logs:2bb9715f15cb72f4):
// the exact round-overload-missing message + the ad-hoc SKU-sales query carrying all three
// fingerprints.
const SAMPLE_MESSAGE = "function round(double precision, integer) does not exist";
const SAMPLE_QUERY = `
  SELECT sku,
         SUM(qty) AS units,
         ROUND(SUM(revenue) / NULLIF(SUM(qty), 0), 2) AS net_per_unit,
         PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY p) AS med_price
  FROM sales_lines
  GROUP BY sku
  ORDER BY units DESC
`;

test("isForeignSupabasePostgresAdhocSkuSalesRoundTypeNoise drops the exact signature sample", () => {
  assert.equal(
    isForeignSupabasePostgresAdhocSkuSalesRoundTypeNoise(SAMPLE_MESSAGE, SAMPLE_QUERY),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresAdhocSkuSalesRoundTypeNoise(
      "ERROR: function round(double precision, integer) does not exist",
      SAMPLE_QUERY,
    ),
    true,
  );
});

test("isForeignSupabasePostgresAdhocSkuSalesRoundTypeNoise KEEPS a different message / a missing fingerprint / empty query / empty message (real regressions still page)", () => {
  // A DIFFERENT message on the same query — the pin is this exact round-type message only.
  assert.equal(
    isForeignSupabasePostgresAdhocSkuSalesRoundTypeNoise(
      'relation "sales_lines" does not exist',
      SAMPLE_QUERY,
    ),
    false,
  );
  // The same round-type error from a query MISSING a fingerprint (e.g. our own product
  // code with a genuine round() type bug) — still pages.
  assert.equal(
    isForeignSupabasePostgresAdhocSkuSalesRoundTypeNoise(
      SAMPLE_MESSAGE,
      "select round(total::double precision, 2) as net_per_unit, med_price from orders",
    ),
    false,
  );
  // Empty query attribute — cannot confirm the fingerprints, still pages.
  assert.equal(
    isForeignSupabasePostgresAdhocSkuSalesRoundTypeNoise(SAMPLE_MESSAGE, ""),
    false,
  );
  // Empty message — still pages.
  assert.equal(
    isForeignSupabasePostgresAdhocSkuSalesRoundTypeNoise("", SAMPLE_QUERY),
    false,
  );
});
