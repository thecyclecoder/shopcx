/**
 * Phase 1 of internal-renewal-cron-respects-dunning-retry-window.
 *
 * Pins the invariant this phase adds at the renewal cron's fan-out junction:
 * dunning is the source of truth for WHEN the next failed-payment retry is
 * allowed. If dunning has a cycle open on the sub with a `next_retry_at`
 * still in the future, the renewal cron MUST skip that candidate on this
 * tick — the payday retry attempt owns it.
 *
 * Pure function, no I/O — a direct import.
 *
 * Run:
 *   npx tsx --test src/lib/inngest/internal-subscription-renewals.dunning-window.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { filterCandidatesByDunningRetryWindow } from "./internal-subscription-renewals";

const SUB_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SUB_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const SUB_C = "cccccccc-cccc-cccc-cccc-cccccccccccc";

const NOW = new Date("2026-07-14T12:00:00Z");
const FUTURE = "2026-07-16T12:00:00Z"; // 2 days from now
const PAST = "2026-07-13T12:00:00Z"; // yesterday

test("Phase 1: a candidate with no active dunning cycle passes through untouched", () => {
  const candidates = [{ id: SUB_A, workspace_id: "w1", shopify_contract_id: null }];
  const kept = filterCandidatesByDunningRetryWindow(candidates, [], NOW);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, SUB_A);
});

test("Phase 1: a candidate whose active cycle has a FUTURE next_retry_at is skipped", () => {
  const candidates = [
    { id: SUB_A, workspace_id: "w1", shopify_contract_id: null },
    { id: SUB_B, workspace_id: "w1", shopify_contract_id: null },
  ];
  const cycles = [
    { subscription_id: SUB_A, next_retry_at: FUTURE }, // future → skip A
  ];
  const kept = filterCandidatesByDunningRetryWindow(candidates, cycles, NOW);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, SUB_B, "B has no cycle, must pass through");
});

test("Phase 1: a candidate whose active cycle has a PAST/due next_retry_at continues to the renewal path", () => {
  const candidates = [{ id: SUB_A, workspace_id: "w1", shopify_contract_id: null }];
  const cycles = [{ subscription_id: SUB_A, next_retry_at: PAST }];
  const kept = filterCandidatesByDunningRetryWindow(candidates, cycles, NOW);
  assert.equal(kept.length, 1, "past retry means dunning is DONE waiting — the cron owns this tick");
  assert.equal(kept[0].id, SUB_A);
});

test("Phase 1: a candidate whose active cycle has a next_retry_at exactly AT now is NOT skipped (strict > now)", () => {
  const candidates = [{ id: SUB_A, workspace_id: "w1", shopify_contract_id: null }];
  const cycles = [{ subscription_id: SUB_A, next_retry_at: NOW.toISOString() }];
  const kept = filterCandidatesByDunningRetryWindow(candidates, cycles, NOW);
  assert.equal(kept.length, 1, "retry moment has ARRIVED — dispatch, don't defer another day");
});

test("Phase 1: a NULL next_retry_at cycle does NOT block the candidate", () => {
  const candidates = [{ id: SUB_A, workspace_id: "w1", shopify_contract_id: null }];
  const cycles = [{ subscription_id: SUB_A, next_retry_at: null }];
  const kept = filterCandidatesByDunningRetryWindow(candidates, cycles, NOW);
  assert.equal(kept.length, 1);
});

test("Phase 1: mixed pages — some future, some past, some absent — only the future-retry subs are dropped", () => {
  const candidates = [
    { id: SUB_A, workspace_id: "w1", shopify_contract_id: null }, // future
    { id: SUB_B, workspace_id: "w1", shopify_contract_id: null }, // past
    { id: SUB_C, workspace_id: "w1", shopify_contract_id: null }, // no cycle
  ];
  const cycles = [
    { subscription_id: SUB_A, next_retry_at: FUTURE },
    { subscription_id: SUB_B, next_retry_at: PAST },
  ];
  const kept = filterCandidatesByDunningRetryWindow(candidates, cycles, NOW);
  assert.deepEqual(
    kept.map((c) => c.id).sort(),
    [SUB_B, SUB_C].sort(),
  );
});

test("Phase 1: an orphan cycle row with a null subscription_id is ignored (never accidentally blocks anyone)", () => {
  const candidates = [{ id: SUB_A, workspace_id: "w1", shopify_contract_id: null }];
  const cycles = [{ subscription_id: null, next_retry_at: FUTURE }];
  const kept = filterCandidatesByDunningRetryWindow(candidates, cycles, NOW);
  assert.equal(kept.length, 1);
});

test("Phase 1: an unparseable next_retry_at string does NOT block the candidate (defensive — never over-hold)", () => {
  const candidates = [{ id: SUB_A, workspace_id: "w1", shopify_contract_id: null }];
  const cycles = [{ subscription_id: SUB_A, next_retry_at: "not-a-date" }];
  const kept = filterCandidatesByDunningRetryWindow(candidates, cycles, NOW);
  assert.equal(kept.length, 1);
});
