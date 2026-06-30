/**
 * Unit tests for the Phase 3 REVERSE direction of growth-winning-creative-amplifier —
 * `pairPromotedLanderWithAd`. Mirrors the spec's verification: a promoted lander variant
 * enqueues a corresponding `ad-tool/static-requested` event AND stamps a
 * `paired_winner_lander` director_activity row.
 *
 * Built-in node:test — run:
 *   npx tsx --test src/lib/storefront/pair-promoted-lander.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  PAIRED_WINNER_LANDER_ACTION_KIND,
  archetypeForPromotedLanderType,
  pairPromotedLanderWithAd,
  type PairPromotedLanderDeps,
} from "./optimizer-agent";

interface InsertedRecord { table: string; values: Record<string, unknown>; }

interface PairFakeStores {
  product_ad_angles: Array<{ id: string; hook_one_liner: string | null; created_at: string }>;
}

function makePairAdmin(stores: PairFakeStores) {
  const inserts: InsertedRecord[] = [];
  let nextCampaignId = 0;
  function readChain(rows: unknown[]) {
    const obj: Record<string, unknown> = {};
    obj.select = () => obj;
    obj.eq = () => obj;
    obj.in = () => obj;
    obj.gte = () => obj;
    obj.order = () => obj;
    obj.limit = () => obj;
    obj.then = (onFulfilled: (v: { data: unknown; error: null }) => unknown) =>
      Promise.resolve({ data: rows, error: null }).then(onFulfilled);
    return obj;
  }
  function insertChain(table: string) {
    const obj: Record<string, unknown> = {};
    let resolved: { data: unknown; error: null } | null = null;
    obj.insert = (values: unknown) => {
      const v = values as Record<string, unknown>;
      inserts.push({ table, values: v });
      if (table === "ad_campaigns") {
        nextCampaignId += 1;
        resolved = { data: { id: `camp-pair-${nextCampaignId}` }, error: null };
      } else {
        resolved = { data: null, error: null };
      }
      return obj;
    };
    obj.select = () => obj;
    obj.maybeSingle = () => obj;
    obj.single = () => obj;
    obj.then = (onFulfilled: (v: { data: unknown; error: null }) => unknown) =>
      Promise.resolve(resolved ?? { data: null, error: null }).then(onFulfilled);
    return obj;
  }
  const admin = {
    from(table: string) {
      if (table === "product_ad_angles") return readChain(stores.product_ad_angles);
      if (table === "ad_campaigns") return insertChain("ad_campaigns");
      return insertChain(table);
    },
  } as unknown as Parameters<typeof pairPromotedLanderWithAd>[0];
  return { admin, inserts };
}

function makePairSpyDeps(): {
  deps: PairPromotedLanderDeps;
  sentInngest: Array<{ name: string; data: unknown }>;
  recordedActivity: Array<Record<string, unknown>>;
} {
  const sentInngest: Array<{ name: string; data: unknown }> = [];
  const recordedActivity: Array<Record<string, unknown>> = [];
  return {
    deps: {
      sendInngest: async (event) => { sentInngest.push(event); return { ids: ["stub"] }; },
      recordActivity: async (_admin, row) => { recordedActivity.push(row as unknown as Record<string, unknown>); return undefined; },
    },
    sentInngest,
    recordedActivity,
  };
}

test("archetypeForPromotedLanderType maps storefront lander_type → maker archetype", () => {
  assert.equal(archetypeForPromotedLanderType("advertorial"), "advertorial");
  assert.equal(archetypeForPromotedLanderType("beforeafter"), "before_after");
  assert.equal(archetypeForPromotedLanderType("listicle"), "testimonial");
});

test("pairPromotedLanderWithAd inserts a fresh ad_campaigns row + fires ad-tool/static-requested + stamps paired_winner_lander", async () => {
  const stores: PairFakeStores = {
    product_ad_angles: [
      { id: "ANG-NEW", hook_one_liner: "still tired at 3pm?", created_at: "2026-06-29T10:00:00Z" },
    ],
  };
  const { admin, inserts } = makePairAdmin(stores);
  const { deps, sentInngest, recordedActivity } = makePairSpyDeps();

  const res = await pairPromotedLanderWithAd(admin, {
    workspaceId: "ws-1",
    productId: "P-1",
    landerType: "advertorial",
    experimentId: "exp-promoted-1",
    variantId: "var-winner",
    specSlug: "growth-winning-creative-amplifier",
    deps,
  });

  assert.equal(res.ok, true);
  assert.equal(res.angle_id, "ANG-NEW");
  assert.equal(res.archetype, "advertorial");
  assert.ok(res.ad_campaign_id?.startsWith("camp-pair-"));
  // One fresh ad_campaigns row at status='ready' tagged to the matching angle.
  const campaignInserts = inserts.filter((i) => i.table === "ad_campaigns");
  assert.equal(campaignInserts.length, 1);
  assert.equal(campaignInserts[0].values.status, "ready");
  assert.equal(campaignInserts[0].values.angle_id, "ANG-NEW");
  assert.equal(campaignInserts[0].values.product_id, "P-1");
  assert.equal(campaignInserts[0].values.workspace_id, "ws-1");
  // The maker pipeline event is fired with the archetype derived from the lander_type.
  assert.equal(sentInngest.length, 1);
  assert.equal(sentInngest[0].name, "ad-tool/static-requested");
  assert.equal((sentInngest[0].data as { archetype: string }).archetype, "advertorial");
  assert.equal((sentInngest[0].data as { campaign_id: string }).campaign_id, res.ad_campaign_id);
  // ONE paired_winner_lander activity row stamped — the cross-side audit trail.
  assert.equal(recordedActivity.length, 1);
  const row = recordedActivity[0] as { actionKind: string; metadata: Record<string, unknown> };
  assert.equal(row.actionKind, PAIRED_WINNER_LANDER_ACTION_KIND);
  assert.equal(row.metadata.direction, "lander_to_ad");
  assert.equal(row.metadata.experiment_id, "exp-promoted-1");
  assert.equal(row.metadata.variant_id, "var-winner");
  assert.equal(row.metadata.lander_type, "advertorial");
  assert.equal(row.metadata.archetype, "advertorial");
});

test("pairPromotedLanderWithAd skips a PDP promote (no matched static archetype on the bare PDP)", async () => {
  const stores: PairFakeStores = {
    product_ad_angles: [
      { id: "ANG-NEW", hook_one_liner: "anything", created_at: "2026-06-29T10:00:00Z" },
    ],
  };
  const { admin, inserts } = makePairAdmin(stores);
  const { deps, sentInngest, recordedActivity } = makePairSpyDeps();

  const res = await pairPromotedLanderWithAd(admin, {
    workspaceId: "ws-1",
    productId: "P-1",
    landerType: "pdp",
    experimentId: "exp-pdp",
    variantId: "var-x",
    deps,
  });

  assert.equal(res.ok, false);
  assert.equal(res.reason, "lander_type_not_advertorial_family");
  assert.equal(inserts.length, 0);
  assert.equal(sentInngest.length, 0);
  assert.equal(recordedActivity.length, 0);
});

test("pairPromotedLanderWithAd refuses when the product has no active angle", async () => {
  const stores: PairFakeStores = { product_ad_angles: [] };
  const { admin, inserts } = makePairAdmin(stores);
  const { deps, sentInngest, recordedActivity } = makePairSpyDeps();

  const res = await pairPromotedLanderWithAd(admin, {
    workspaceId: "ws-1",
    productId: "P-1",
    landerType: "beforeafter",
    experimentId: "exp-no-angle",
    variantId: "var-x",
    deps,
  });

  assert.equal(res.ok, false);
  assert.equal(res.reason, "no_matching_angle");
  assert.equal(inserts.length, 0);
  assert.equal(sentInngest.length, 0);
  assert.equal(recordedActivity.length, 0);
});
