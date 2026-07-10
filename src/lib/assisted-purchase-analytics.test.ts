/**
 * Unit tests for the concierge-flow funnel analytics slice — Phase 5 of
 * docs/brain/specs/checkout-stuck-defaults-to-assisted-purchase-concierge-sonnet-and-sol.md.
 *
 * Pins the SQL shape + params vector — the slice is queryable via a
 * parameterized-query transport (an RPC, a direct pg driver, etc.). The pure
 * builders keep the shape testable and out-of-schema.
 *
 * Run:
 *   npx tsx --test src/lib/assisted-purchase-analytics.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAssistedPurchaseFunnelParams,
  buildAssistedPurchaseFunnelSql,
} from "./assisted-purchase-analytics";

const INPUT = {
  workspaceId: "11111111-1111-1111-1111-111111111111",
  windowStart: "2026-07-01T00:00:00Z",
  windowEnd: "2026-08-01T00:00:00Z",
} as const;

// ── SQL shape ─────────────────────────────────────────────────────────────

test("SQL: emits WITH clauses for the three funnel stages — checkout_stuck, assisted_started, orders_placed", () => {
  const sql = buildAssistedPurchaseFunnelSql(INPUT);
  assert.match(sql, /WITH\s+checkout_stuck AS/);
  assert.match(sql, /,\s*assisted_started AS/);
  assert.match(sql, /,\s*orders_placed AS/);
});

test("SQL: checkout_stuck CTE keys off the Phase-2 inflection stamp AND the Phase-3 Direction blueprint", () => {
  const sql = buildAssistedPurchaseFunnelSql(INPUT);
  assert.match(sql, /reasoning = 'sol:inflection-drift'/);
  assert.match(sql, /'stage1_checkout_stuck'/);
  assert.match(sql, /'add-payment-method'/, "checkout_stuck must recognize the Phase-3 blueprint journey slug too");
});

test("SQL: assisted_started CTE joins to public.playbooks by slug (Phase-4 handoff)", () => {
  const sql = buildAssistedPurchaseFunnelSql(INPUT);
  assert.match(sql, /public\.playbooks p/);
  assert.match(sql, /p\.slug = \(td\.plan->>'playbook_slug'\)/);
  assert.match(sql, /p\.slug = ANY \(\$4::text\[\]\)/);
});

test("SQL: orders_placed CTE keys off the Phase-4 execute-then-confirm signal on tickets.playbook_context", () => {
  const sql = buildAssistedPurchaseFunnelSql(INPUT);
  assert.match(sql, /playbook_context->>'assisted_purchase_completed'/);
});

test("SQL: recovered_revenue_cents extracts the $NN.NN pattern from assisted_purchase_result_summary", () => {
  const sql = buildAssistedPurchaseFunnelSql(INPUT);
  assert.match(sql, /assisted_purchase_result_summary/);
  assert.match(sql, /regexp_match/);
  assert.match(sql, /\* 100/, "revenue must be converted to cents");
});

test("SQL: workspace + window are bound via $1..$3 (parameterized — never string-concat)", () => {
  const sql = buildAssistedPurchaseFunnelSql(INPUT);
  assert.match(sql, /\$1::uuid AS workspace_id/);
  assert.match(sql, /\$2::timestamptz AS window_start/);
  assert.match(sql, /\$3::timestamptz AS window_end/);
  // The workspaceId literal must NEVER appear in the SQL body (that would be string-concat).
  assert.doesNotMatch(sql, new RegExp(INPUT.workspaceId));
  assert.doesNotMatch(sql, new RegExp(INPUT.windowStart));
});

test("SQL: division ratios are ROUND'd + guarded against divide-by-zero via NULLIF", () => {
  const sql = buildAssistedPurchaseFunnelSql(INPUT);
  assert.match(sql, /NULLIF\(/, "every division must guard against divide-by-zero");
  assert.match(sql, /, 0\)/);
  assert.match(sql, /ROUND\(/);
});

test("SQL: three ratios are emitted — start_rate, placement_rate, end_to_end_conversion", () => {
  const sql = buildAssistedPurchaseFunnelSql(INPUT);
  assert.match(sql, /AS start_rate/);
  assert.match(sql, /AS placement_rate/);
  assert.match(sql, /AS end_to_end_conversion/);
});

test("SQL: the checkout_stuck=0 branches return 0 (not NULL) so the tile can render zeros safely", () => {
  const sql = buildAssistedPurchaseFunnelSql(INPUT);
  assert.match(sql, /WHEN \(SELECT COUNT\(\*\) FROM checkout_stuck\) = 0 THEN 0::numeric/);
});

// ── Params vector shape ──────────────────────────────────────────────────

test("params: vector is [workspaceId, windowStart, windowEnd, [oneTime, subscribeAndSave]] — matches $1..$4", () => {
  const params = buildAssistedPurchaseFunnelParams(INPUT);
  assert.equal(params.length, 4);
  assert.equal(params[0], INPUT.workspaceId);
  assert.equal(params[1], INPUT.windowStart);
  assert.equal(params[2], INPUT.windowEnd);
  assert.deepEqual(params[3], ["assisted-order-purchase", "assisted-subscription-purchase"]);
});

test("params: the playbook-slug array is EXACTLY the two Phase-4 assisted-purchase slugs — no other slugs surface", () => {
  const params = buildAssistedPurchaseFunnelParams(INPUT);
  const slugs = params[3] as readonly string[];
  assert.equal(slugs.length, 2);
  assert.ok(slugs.includes("assisted-order-purchase"));
  assert.ok(slugs.includes("assisted-subscription-purchase"));
});
