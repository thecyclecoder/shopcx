/**
 * Unit tests for aggregatePlaybookSelectionSplit — Phase 4 of
 * docs/brain/specs/sol-session-chosen-playbook-selection-retire-brittle-triggers.md.
 *
 * The route reads `ticket_resolution_events.reasoning` over the last 7 days and hands the rows
 * to this pure aggregator, so the test only needs to pin the reasoning-string parsing.
 *
 * Pure helper — no network, no DB. Run:
 *   npx tsx --test src/app/api/tickets/analytics/playbook-selection-split/aggregator.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { aggregatePlaybookSelectionSplit } from "./route";

test("empty input → zero totals + empty per_slug", () => {
  const out = aggregatePlaybookSelectionSplit([]);
  assert.equal(out.total_session_chosen, 0);
  assert.equal(out.total_matcher_chosen, 0);
  assert.deepEqual(out.per_slug, {});
});

test("session-chose row → total_session_chosen++ and slug bucket increments", () => {
  const out = aggregatePlaybookSelectionSplit([
    { reasoning: "sol:session-chose-playbook:refund" },
    { reasoning: "sol:session-chose-playbook:refund" },
    { reasoning: "sol:session-chose-playbook:replacement-order" },
  ]);
  assert.equal(out.total_session_chosen, 3);
  assert.equal(out.total_matcher_chosen, 0);
  assert.deepEqual(out.per_slug, {
    refund: { session_chosen: 2, matcher_chosen: 0 },
    "replacement-order": { session_chosen: 1, matcher_chosen: 0 },
  });
});

test("matcher-chose row → total_matcher_chosen++ and slug bucket increments", () => {
  const out = aggregatePlaybookSelectionSplit([
    { reasoning: "sol:matcher-chose-playbook:refund" },
    { reasoning: "sol:matcher-chose-playbook:assisted-purchase-classic" },
  ]);
  assert.equal(out.total_session_chosen, 0);
  assert.equal(out.total_matcher_chosen, 2);
  assert.deepEqual(out.per_slug, {
    refund: { session_chosen: 0, matcher_chosen: 1 },
    "assisted-purchase-classic": { session_chosen: 0, matcher_chosen: 1 },
  });
});

test("mixed sources on the same slug bucket into { session_chosen, matcher_chosen }", () => {
  const out = aggregatePlaybookSelectionSplit([
    { reasoning: "sol:session-chose-playbook:refund" },
    { reasoning: "sol:matcher-chose-playbook:refund" },
    { reasoning: "sol:session-chose-playbook:refund" },
    { reasoning: "sol:matcher-chose-playbook:refund" },
    { reasoning: "sol:matcher-chose-playbook:refund" },
  ]);
  assert.equal(out.total_session_chosen, 2);
  assert.equal(out.total_matcher_chosen, 3);
  assert.deepEqual(out.per_slug, {
    refund: { session_chosen: 2, matcher_chosen: 3 },
  });
});

test("rows that don't carry a playbook-selection prefix are IGNORED (safe co-existence with other reasoning strings)", () => {
  const out = aggregatePlaybookSelectionSplit([
    { reasoning: "sol:cap-hit" },
    { reasoning: "sol:playbook-shortcircuit" },
    { reasoning: "sol:inflection-frustration" },
    { reasoning: "sol:session-chose-playbook:refund" },
    { reasoning: null },
    { reasoning: "" },
  ]);
  assert.equal(out.total_session_chosen, 1);
  assert.equal(out.total_matcher_chosen, 0);
  assert.deepEqual(out.per_slug, {
    refund: { session_chosen: 1, matcher_chosen: 0 },
  });
});

test("empty slug suffix (unusual/never-written) → row skipped, not bucketed under ''", () => {
  const out = aggregatePlaybookSelectionSplit([
    { reasoning: "sol:session-chose-playbook:" },
    { reasoning: "sol:matcher-chose-playbook:" },
  ]);
  assert.equal(out.total_session_chosen, 0);
  assert.equal(out.total_matcher_chosen, 0);
  assert.deepEqual(out.per_slug, {});
});

test("slug with hyphens/colons preserved verbatim (Sol's plan.playbook_slug is opaque to the aggregator)", () => {
  const out = aggregatePlaybookSelectionSplit([
    { reasoning: "sol:session-chose-playbook:assisted-purchase-classic-v2" },
    { reasoning: "sol:matcher-chose-playbook:assisted-purchase-classic-v2" },
  ]);
  assert.equal(out.total_session_chosen, 1);
  assert.equal(out.total_matcher_chosen, 1);
  assert.deepEqual(out.per_slug, {
    "assisted-purchase-classic-v2": { session_chosen: 1, matcher_chosen: 1 },
  });
});
