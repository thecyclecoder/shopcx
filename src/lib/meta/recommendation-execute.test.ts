/**
 * Unit tests for the media-buyer new_campaign adapter — Phase 2 of
 * meta-campaign-adset-creation-primitive.
 *
 * Run:  npx tsx --test src/lib/meta/recommendation-execute.test.ts
 *
 * Covers the two verification predicates from the spec:
 *   1) `new_campaign` is NO LONGER in the deferred/disabled set (enabled adapter).
 *   2) The pure governor-headroom predicate ESCALATES (returns `ok:false`) when
 *      the proposed ad-set daily budget × window would push the account past its
 *      `ad_spend_budgets` ceiling — the "governor / test ceiling" guard the spec
 *      requires. When headroom is available, it returns `ok:true`.
 *
 * These are the exact named failing states from the coaching:
 *   - "new_campaign / new_adset are no longer in the deferred/disabled set"
 *   - "a request that would exceed the governor / test ceiling does NOT create a
 *      live object — it escalates"
 * Wiring them into the smallest test-first assertions guards the predicates
 * from silent drift.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ENABLED_ADAPTERS, evaluateGovernorHeadroom } from "./recommendation-execute";
import type { AdSpendBudget } from "@/lib/ad-spend-governor";

const BUDGET_50: AdSpendBudget = {
  id: "b-1",
  workspaceId: "ws-1",
  metaAdAccountId: "acct-uuid-1",
  platform: "meta",
  windowDays: 7,
  usdCeilingCents: 50000, // $500 / 7d ceiling
  notes: null,
  updatedBy: null,
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-01T00:00:00Z",
};

test("ENABLED_ADAPTERS includes new_campaign (deferred → enabled by Phase 2)", () => {
  assert.equal(ENABLED_ADAPTERS.has("new_campaign"), true, "new_campaign must be enabled");
  // Existing adapters stay enabled — Phase 2 only ADDS to the set.
  assert.equal(ENABLED_ADAPTERS.has("new_static_adset"), true);
  assert.equal(ENABLED_ADAPTERS.has("new_video_adset"), true);
});

test("evaluateGovernorHeadroom — null budget = ok (no ceiling configured)", () => {
  const r = evaluateGovernorHeadroom(null, 0, 10000);
  assert.equal(r.ok, true);
  assert.equal(r.reason, undefined);
});

test("evaluateGovernorHeadroom — proposed × window under remaining headroom = ok", () => {
  // Ceiling $500 / 7d, already spent $200 → $300 headroom.
  // Proposed $30/day × 7d = $210 → within headroom.
  const r = evaluateGovernorHeadroom(BUDGET_50, 20000, 3000);
  assert.equal(r.ok, true, `should be ok, got ${r.reason}`);
  assert.equal(r.projectedCents, 20000 + 3000 * 7);
  assert.equal(r.ceilingCents, 50000);
});

test("evaluateGovernorHeadroom — proposed × window OVER remaining headroom = escalate", () => {
  // Ceiling $500 / 7d, already spent $400 → $100 headroom.
  // Proposed $30/day × 7d = $210 → blows past $500 ($400 + $210 = $610).
  const r = evaluateGovernorHeadroom(BUDGET_50, 40000, 3000);
  assert.equal(r.ok, false, "must escalate — a live object would exceed the ceiling");
  assert.ok(r.reason && r.reason.includes("ceiling"), `reason cites the ceiling, got: ${r.reason}`);
  assert.equal(r.projectedCents, 40000 + 3000 * 7);
});

test("evaluateGovernorHeadroom — proposed alone (empty history) already over ceiling = escalate", () => {
  // A single day's proposed budget × window exceeds the ceiling on its own.
  // Ceiling $500 / 7d, actual 0, proposed $100/day × 7d = $700.
  const r = evaluateGovernorHeadroom(BUDGET_50, 0, 10000);
  assert.equal(r.ok, false);
  assert.equal(r.projectedCents, 70000);
});

test("evaluateGovernorHeadroom — zero proposed budget uses actual only", () => {
  // Caller passed no daily_budget_cents — we still enforce the ceiling on
  // whatever is already burning, so an already-breached account escalates.
  const r = evaluateGovernorHeadroom(BUDGET_50, 60000, 0);
  assert.equal(r.ok, false);
  assert.equal(r.projectedCents, 60000);
});
