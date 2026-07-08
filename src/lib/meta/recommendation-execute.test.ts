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
import {
  ENABLED_ADAPTERS,
  evaluateGovernorHeadroom,
  reconcileCreatedAdSetToMirror,
} from "./recommendation-execute";
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

// ── Phase 3 — mirror reconcile ────────────────────────────────────────────────

interface FakeUpsertCall {
  table: string;
  rows: Record<string, unknown>[];
  onConflict?: string;
}

function fakeAdminCapturingUpserts(returnError?: { message: string; code?: string }) {
  const calls: FakeUpsertCall[] = [];
  const admin = {
    from(table: string) {
      return {
        upsert(rows: Record<string, unknown>[], opts?: { onConflict?: string }) {
          calls.push({ table, rows, onConflict: opts?.onConflict });
          return Promise.resolve({ error: returnError ?? null });
        },
      };
    },
  };
  // The real admin client has many methods we don't touch here — the reconcile
  // helper only ever calls .from(table).upsert(rows, {onConflict}), so this
  // cast is safe for the test.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { admin: admin as any, calls };
}

test("reconcileCreatedAdSetToMirror — upserts one campaign + one ad set with the natural keys the mirror uses", async () => {
  const { admin, calls } = fakeAdminCapturingUpserts();
  await reconcileCreatedAdSetToMirror(admin, {
    workspaceId: "ws-1",
    metaAdAccountId: "acct-uuid-1",
    metaCampaignId: "23842000000000001",
    campaignName: "MB — Testing (ABO)",
    campaignObjective: "OUTCOME_SALES",
    metaAdsetId: "23842000000000002",
    adsetName: "[ie] test — concept 42",
    optimizationGoal: "OFFSITE_CONVERSIONS",
    dailyBudgetCents: 5000,
    status: "PAUSED",
    syncedAt: "2026-07-07T00:00:00Z",
  });

  const campaigns = calls.filter((c) => c.table === "meta_campaigns");
  const adsets = calls.filter((c) => c.table === "meta_adsets");
  assert.equal(campaigns.length, 1, "one meta_campaigns upsert");
  assert.equal(adsets.length, 1, "one meta_adsets upsert");

  // Campaign upsert shape — the natural-key `onConflict` MUST match the unique index.
  const [cUpsert] = campaigns;
  assert.equal(cUpsert.onConflict, "workspace_id,meta_campaign_id");
  assert.equal(cUpsert.rows.length, 1);
  const cRow = cUpsert.rows[0];
  assert.equal(cRow.workspace_id, "ws-1");
  assert.equal(cRow.meta_ad_account_id, "acct-uuid-1");
  assert.equal(cRow.meta_campaign_id, "23842000000000001");
  assert.equal(cRow.name, "MB — Testing (ABO)");
  assert.equal(cRow.status, "PAUSED");
  assert.equal(cRow.objective, "OUTCOME_SALES");
  // ABO campaign — no campaign-level budget stored on the mirror.
  assert.equal(cRow.daily_budget_cents, null);

  // Ad set upsert shape.
  const [aUpsert] = adsets;
  assert.equal(aUpsert.onConflict, "workspace_id,meta_adset_id");
  const aRow = aUpsert.rows[0];
  assert.equal(aRow.workspace_id, "ws-1");
  assert.equal(aRow.meta_ad_account_id, "acct-uuid-1");
  assert.equal(aRow.meta_adset_id, "23842000000000002");
  assert.equal(aRow.meta_campaign_id, "23842000000000001", "parent-link is the campaign's Meta id (text natural key)");
  assert.equal(aRow.name, "[ie] test — concept 42");
  assert.equal(aRow.status, "PAUSED");
  assert.equal(aRow.optimization_goal, "OFFSITE_CONVERSIONS");
  assert.equal(aRow.daily_budget_cents, 5000);
  assert.equal(aRow.synced_at, "2026-07-07T00:00:00Z");
});

test("reconcileCreatedAdSetToMirror — bubbles the supabase error rather than silently swallowing it", async () => {
  const { admin } = fakeAdminCapturingUpserts({ message: "duplicate key", code: "23505" });
  await assert.rejects(
    () =>
      reconcileCreatedAdSetToMirror(admin, {
        workspaceId: "ws-1",
        metaAdAccountId: "acct-uuid-1",
        metaCampaignId: "c-1",
        campaignName: "x",
        campaignObjective: "OUTCOME_SALES",
        metaAdsetId: "a-1",
        adsetName: "y",
        optimizationGoal: "OFFSITE_CONVERSIONS",
        dailyBudgetCents: null,
        status: "PAUSED",
        syncedAt: "2026-07-07T00:00:00Z",
      }),
    /meta_campaigns upsert failed/,
    "must surface the PG error — a swallowed upsert would leave the mirror stale (performance.ts:29-33)",
  );
});
