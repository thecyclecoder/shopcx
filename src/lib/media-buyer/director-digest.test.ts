/**
 * Unit test for media-buyer-digest-consolidate-product-names-suppress-noop Phase 1.
 *
 * Pins two gates on `composeDigest`:
 *   1) A pass with active policy but zero total actions returns `hasRecommendations=false`
 *      (so `deliverMediaBuyerDigest` will suppress the post — no "no changes recommended"
 *      Slack noise every 2h).
 *   2) A cohort with a resolved `productTitle` labels its line by that title
 *      ("Amazing Coffee — …"), and only a null-product cohort keeps the
 *      `account <id8>` fallback.
 *
 * Run:
 *   npx tsx --test src/lib/media-buyer/director-digest.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { composeDigest, resolveProductTitlesForWorkspace, type AccountPlan } from "./director-digest";
import type {
  MediaBuyerPlan,
  MediaBuyerPromoteAction,
  MediaBuyerReplenishAction,
} from "./agent";

function plan(overrides: Partial<MediaBuyerPlan> = {}): MediaBuyerPlan {
  return {
    policyActive: true,
    policyVersionId: "policy-1",
    cohortConfigured: true,
    cohortTargetCount: 4,
    currentTestCohortSize: 4,
    promote: [],
    kill: [],
    replenish: [],
    fatigueReplenish: [],
    replenishDiagnostic: null,
    summary: "cohort full; no winners; no losers",
    ...overrides,
  };
}

function promote(): MediaBuyerPromoteAction {
  return {
    kind: "promote",
    sourceMetaAdId: "ad-1",
    roas: 3.2,
    spendCents: 5000,
    targetLevel: "adset",
    targetObjectId: "as-1",
    beforeBudgetCents: 5000,
    afterBudgetCents: 10000,
    rationale: "roas>floor",
    policyVersionId: "policy-1",
    sourceAdCampaignId: null,
  };
}

function replenish(): MediaBuyerReplenishAction {
  return {
    kind: "replenish",
    adCampaignId: "camp-1",
    testMetaAdsetId: "meta-as-1",
    adsetPerTest: false,
    dailyTestCeilingCents: 60_000,
    rationale: "top up",
  };
}

test("composeDigest: active policy + zero actions reports hasRecommendations=false", () => {
  const plans: AccountPlan[] = [
    { account: "acct-01234567-abcd", productId: "prod-1", productTitle: "Amazing Coffee", plan: plan() },
  ];
  const { hasRecommendations, text } = composeDigest(plans);
  assert.equal(hasRecommendations, false, "no promote/kill/replenish/fatigue → no actionable recommendations");
  // Header still lists the cohort count so the composition is stable, but the caller
  // (`deliverMediaBuyerDigest`) must suppress the post on hasRecommendations=false.
  assert.match(text, /no changes recommended this cycle/);
});

test("composeDigest: cohort with productTitle labels line by product, not account id", () => {
  const plans: AccountPlan[] = [
    {
      account: "acct-abcdef12-3456",
      productId: "prod-1",
      productTitle: "Amazing Coffee",
      plan: plan({
        promote: [promote()],
        summary: "1 winner to scale",
      }),
    },
  ];
  const { hasRecommendations, text } = composeDigest(plans);
  assert.equal(hasRecommendations, true);
  assert.match(text, /• Amazing Coffee — 1 winner to scale/, "line labelled by product title");
  assert.doesNotMatch(text, /• account /, "no account-id line label when productTitle is present");
});

test("composeDigest: null-cohort (product-null) falls back to `account <id8>` label", () => {
  const plans: AccountPlan[] = [
    {
      account: "acct-legacy-tabs-01",
      productId: null,
      productTitle: null,
      plan: plan({
        replenish: [replenish()],
        summary: "top up",
      }),
    },
  ];
  const { hasRecommendations, text } = composeDigest(plans);
  assert.equal(hasRecommendations, true);
  assert.match(text, /• account acct-leg — top up/, "null-product cohort keeps account fallback");
});

// ── Fix 1 (spec-test regression fix) — workspace-scoped product-title lookup ───

/**
 * Fake admin client that emulates the `.from("products").select("id, title").eq("workspace_id",
 * X).in("id", [...])` chain. Filters the seeded rows by BOTH `.eq("workspace_id", …)` and
 * `.in("id", …)` — so a product that belongs to a different workspace silently drops out (i.e.
 * the RLS scope is enforced at the read layer, exactly what `resolveProductTitlesForWorkspace`
 * relies on).
 */
function fakeAdminWithProducts(rows: Array<{ id: string; workspace_id: string; title: string | null }>) {
  return {
    from(table: string) {
      if (table !== "products") throw new Error(`unexpected table: ${table}`);
      let ws: string | null = null;
      let ids: readonly string[] = [];
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          if (col === "workspace_id") ws = String(val);
          return chain;
        },
        in: (col: string, val: readonly string[]) => {
          if (col === "id") ids = val;
          return chain;
        },
        then: (onFulfilled: (v: { data: Array<{ id: string; title: string | null }>; error: null }) => unknown) =>
          Promise.resolve({
            data: rows
              .filter((r) => (ws === null || r.workspace_id === ws) && ids.includes(r.id))
              .map((r) => ({ id: r.id, title: r.title })),
            error: null as null,
          }).then(onFulfilled),
      };
      return chain;
    },
  } as unknown as Parameters<typeof resolveProductTitlesForWorkspace>[0];
}

test("resolveProductTitlesForWorkspace: two product IDs, only one in workspace → only the in-workspace title is used", async () => {
  const WS = "ws-1";
  const OTHER_WS = "ws-2";
  const admin = fakeAdminWithProducts([
    { id: "prod-in", workspace_id: WS, title: "Amazing Coffee" },
    { id: "prod-out", workspace_id: OTHER_WS, title: "Somebody Else's Product" },
  ]);
  const map = await resolveProductTitlesForWorkspace(admin, WS, ["prod-in", "prod-out"]);
  assert.equal(map.get("prod-in"), "Amazing Coffee", "in-workspace product title is resolved");
  assert.equal(
    map.get("prod-out"),
    undefined,
    "cross-workspace product title MUST NOT leak — falls back to account label in composeDigest",
  );
  assert.equal(map.size, 1);
});

test("resolveProductTitlesForWorkspace: empty productIds → no DB call, empty Map", async () => {
  const called = { from: 0 };
  const admin = {
    from() {
      called.from++;
      throw new Error("must not query");
    },
  } as unknown as Parameters<typeof resolveProductTitlesForWorkspace>[0];
  const map = await resolveProductTitlesForWorkspace(admin, "ws-1", []);
  assert.equal(map.size, 0);
  assert.equal(called.from, 0);
});

test("resolveProductTitlesForWorkspace: null-title row silently dropped (composeDigest falls back)", async () => {
  const WS = "ws-1";
  const admin = fakeAdminWithProducts([
    { id: "prod-untitled", workspace_id: WS, title: null },
    { id: "prod-titled", workspace_id: WS, title: "Superfood Creamer" },
  ]);
  const map = await resolveProductTitlesForWorkspace(admin, WS, ["prod-untitled", "prod-titled"]);
  assert.equal(map.get("prod-untitled"), undefined);
  assert.equal(map.get("prod-titled"), "Superfood Creamer");
  assert.equal(map.size, 1);
});

test("composeDigest: mixed cohorts — product-labelled + fallback in the same digest", () => {
  const plans: AccountPlan[] = [
    {
      account: "acct-shared-1",
      productId: "prod-coffee",
      productTitle: "Amazing Coffee",
      plan: plan({
        promote: [promote()],
        summary: "scale 1",
      }),
    },
    {
      account: "acct-shared-1",
      productId: "prod-creamer",
      productTitle: "Superfood Creamer",
      plan: plan({ summary: "hold" }),
    },
  ];
  const { text, hasRecommendations } = composeDigest(plans);
  assert.equal(hasRecommendations, true);
  assert.match(text, /• Amazing Coffee — scale 1/);
  assert.match(text, /• Superfood Creamer — hold/);
  assert.doesNotMatch(text, /• account /);
});
