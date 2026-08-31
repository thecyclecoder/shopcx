/**
 * Unit tests for `createCampaign` / `createAdSet` / `getOrCreateTestingCampaign`
 * — meta-campaign-adset-creation-primitive Phase 1 verification.
 *
 * Run:  npx tsx --test src/lib/meta-ads.create.test.ts
 *
 * Non-destructive: stubs `globalThis.fetch` so `graphFetchJson` never hits Meta.
 * Asserts the Graph URL + form-encoded body shape our media-buyer loop depends on:
 *   - createCampaign defaults to a PAUSED ABO OUTCOME_SALES campaign with
 *     `is_adset_budget_sharing_enabled=false` and NO campaign budget.
 *   - createAdSet defaults to PAUSED, `optimization_goal=OFFSITE_CONVERSIONS`,
 *     `bid_strategy=LOWEST_COST_WITHOUT_CAP`, `promoted_object.custom_event_type=PURCHASE`,
 *     and Advantage+ placements (no publisher_platforms / *_positions).
 *   - getOrCreateTestingCampaign is idempotent — a second call returns the same id
 *     without POSTing a new campaign.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  MB_TESTING_CAMPAIGN_NAME,
  coldScalerCampaignName,
  createAdSet,
  createCampaign,
  getOrCreateColdScalerCampaign,
  getOrCreateTestingCampaign,
} from "./meta-ads";

interface Call { url: string; method: string; body: URLSearchParams }

function stubFetch(handler: (call: Call) => { status?: number; json: Record<string, unknown> }) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method || "GET";
    const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams();
    const call = { url, method, body };
    calls.push(call);
    const { status, json } = handler(call);
    return new Response(JSON.stringify(json), {
      status: status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return {
    calls,
    restore() { globalThis.fetch = original; },
  };
}

test("createCampaign — PAUSED ABO OUTCOME_SALES defaults", async () => {
  const stub = stubFetch(() => ({ json: { id: "23842000000000001" } }));
  try {
    const id = await createCampaign("token", "act_9999", { name: "MB — Testing (ABO)" });
    assert.equal(id, "23842000000000001");
    assert.equal(stub.calls.length, 1);
    const [call] = stub.calls;
    assert.equal(call.method, "POST");
    assert.ok(call.url.includes("/act_9999/campaigns"), `campaigns endpoint, got ${call.url}`);
    assert.equal(call.body.get("name"), "MB — Testing (ABO)");
    assert.equal(call.body.get("objective"), "OUTCOME_SALES");
    assert.equal(call.body.get("buying_type"), "AUCTION");
    assert.equal(call.body.get("status"), "PAUSED");
    // Meta REJECTS an ABO campaign without this flag when no campaign budget is set.
    assert.equal(call.body.get("is_adset_budget_sharing_enabled"), "false");
    // ABO ⇒ campaign has NO budget — ad sets each carry their own.
    assert.equal(call.body.get("daily_budget"), null);
    assert.equal(call.body.get("lifetime_budget"), null);
    // Nested arrays are JSON-stringified (form-encoded convention).
    assert.equal(call.body.get("special_ad_categories"), "[]");
  } finally {
    stub.restore();
  }
});

test("createCampaign — CBO carries a daily_budget in minor units and no ABO flag", async () => {
  const stub = stubFetch(() => ({ json: { id: "cbo-1" } }));
  try {
    await createCampaign("token", "act_9999", {
      name: "MB — Scaling (CBO)",
      abo: false,
      dailyBudgetCents: 20000,
    });
    const [call] = stub.calls;
    assert.equal(call.body.get("daily_budget"), "20000");
    assert.equal(call.body.get("is_adset_budget_sharing_enabled"), null);
  } finally {
    stub.restore();
  }
});

test("createAdSet — PAUSED purchase-optimized defaults + Advantage+ placements", async () => {
  const stub = stubFetch(() => ({ json: { id: "23842000000000002" } }));
  try {
    const id = await createAdSet("token", "act_9999", {
      name: "MB — Test — concept_42",
      campaignId: "23842000000000001",
      dailyBudgetCents: 5000,
      pixelId: "111222333",
      targeting: { geo_locations: { countries: ["US"] }, age_min: 25, age_max: 65 },
    });
    assert.equal(id, "23842000000000002");
    assert.equal(stub.calls.length, 1);
    const [call] = stub.calls;
    assert.ok(call.url.includes("/act_9999/adsets"));
    assert.equal(call.body.get("campaign_id"), "23842000000000001");
    assert.equal(call.body.get("optimization_goal"), "OFFSITE_CONVERSIONS");
    assert.equal(call.body.get("billing_event"), "IMPRESSIONS");
    assert.equal(call.body.get("bid_strategy"), "LOWEST_COST_WITHOUT_CAP");
    assert.equal(call.body.get("status"), "PAUSED");
    assert.equal(call.body.get("daily_budget"), "5000");

    const promoted = JSON.parse(call.body.get("promoted_object") || "{}");
    assert.equal(promoted.pixel_id, "111222333");
    assert.equal(promoted.custom_event_type, "PURCHASE");

    // Advantage+ placements: caller-provided targeting is passed through untouched;
    // the ad-set body itself must NOT force publisher_platforms/*_positions.
    const targeting = JSON.parse(call.body.get("targeting") || "{}");
    assert.equal(targeting.publisher_platforms, undefined);
    assert.equal(targeting.facebook_positions, undefined);
    assert.equal(targeting.instagram_positions, undefined);
    assert.deepEqual(targeting.geo_locations, { countries: ["US"] });
  } finally {
    stub.restore();
  }
});

test("createCampaign — a CBO campaign ALWAYS sends an explicit bid_strategy (default: no bid limit)", async () => {
  // Regression: omitting bid_strategy let Meta apply the AD ACCOUNT default. On account
  // 196487894712827 that default is LOWEST_COST_WITH_BID_CAP, so the scaler minted WITH a
  // bid cap and the follow-up createAdSet died on
  // `(#100/1815857) Bid Amount Required For The Bid Strategy Provided` (2026-07-27).
  const stub = stubFetch(() => ({ json: { id: "cbo-1" } }));
  try {
    await createCampaign("token", "act_9999", { name: "CBO", abo: false, dailyBudgetCents: 20000 });
    const [call] = stub.calls;
    assert.equal(call.body.get("bid_strategy"), "LOWEST_COST_WITHOUT_CAP");
    assert.equal(call.body.get("daily_budget"), "20000");
  } finally {
    stub.restore();
  }
});

test("createCampaign — an explicit bidStrategy + bidAmountCents both reach the wire", async () => {
  const stub = stubFetch(() => ({ json: { id: "cbo-2" } }));
  try {
    await createCampaign("token", "act_9999", {
      name: "CBO capped", abo: false, dailyBudgetCents: 20000,
      bidStrategy: "LOWEST_COST_WITH_BID_CAP", bidAmountCents: 1500,
    });
    const [call] = stub.calls;
    assert.equal(call.body.get("bid_strategy"), "LOWEST_COST_WITH_BID_CAP");
    assert.equal(call.body.get("bid_amount"), "1500");
  } finally {
    stub.restore();
  }
});

test("createCampaign — an ABO campaign leaves bid_strategy to the ad set", async () => {
  const stub = stubFetch(() => ({ json: { id: "abo-1" } }));
  try {
    await createCampaign("token", "act_9999", { name: "ABO" });
    const [call] = stub.calls;
    assert.equal(call.body.get("bid_strategy"), null);
    assert.equal(call.body.get("is_adset_budget_sharing_enabled"), "false");
  } finally {
    stub.restore();
  }
});

test("createCampaign — baseline test-campaign call omits new-customer knobs entirely", async () => {
  const stub = stubFetch(() => ({ json: { id: "test-1" } }));
  try {
    await createCampaign("token", "act_9999", { name: "MB — Testing (ABO)" });
    const [call] = stub.calls;
    // Absent → the Advantage+ Sales knobs must not appear on the wire.
    assert.equal(call.body.get("existing_customer_budget_percentage"), null);
    assert.equal(call.body.get("smart_promotion_type"), null);
  } finally {
    stub.restore();
  }
});

test("getOrCreateColdScalerCampaign — mints PAUSED **ABO** OUTCOME_SALES with NO campaign budget, no bid limit, no ASC knobs, idempotent on second call", async () => {
  // ⭐ CEO 2026-08-25: the scaler is ABO, not CBO. A CBO/Advantage+ scaler hands ALLOCATION to
  // Meta — crowned winners graduated into one and Meta put ~95% of spend behind a single ad, so
  // the portfolio never got funded. Per-adset budgets keep allocation ours. `dailyCeilingCents`
  // must therefore NOT reach the wire as a campaign budget; it stays a cohort-row governance cap.
  const cohortId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const expectedName = coldScalerCampaignName(cohortId);
  assert.equal(expectedName, "MB — Cold Scaler (aaaaaaaa)");
  let campaignRows: Array<{ id: string; name: string; status: string }> = [];
  const stub = stubFetch((call) => {
    if (call.method === "GET" && call.url.includes("/act_9999/campaigns")) {
      return { json: { data: campaignRows } };
    }
    if (call.method === "POST" && call.url.includes("/act_9999/campaigns")) {
      const created = { id: "cold-scaler-1", name: expectedName, status: "PAUSED" };
      campaignRows = [...campaignRows, created];
      return { json: { id: created.id } };
    }
    throw new Error(`unexpected call: ${call.method} ${call.url}`);
  });
  try {
    const first = await getOrCreateColdScalerCampaign("token", "act_9999", {
      cohortId,
      dailyCeilingCents: 20000,
    });
    const second = await getOrCreateColdScalerCampaign("token", "act_9999", {
      cohortId,
      dailyCeilingCents: 20000,
    });
    assert.equal(first, "cold-scaler-1");
    assert.equal(second, first, "second call must return the same campaign id");
    const posts = stub.calls.filter((c) => c.method === "POST");
    assert.equal(posts.length, 1, "second call must NOT POST a new campaign");
    const [post] = posts;
    assert.equal(post.body.get("name"), expectedName);
    assert.equal(post.body.get("objective"), "OUTCOME_SALES");
    assert.equal(post.body.get("status"), "PAUSED");
    // ⭐ the wedge: no campaign-level budget on an ABO scaler.
    assert.equal(post.body.get("daily_budget"), null, "ABO scaler must carry NO campaign budget");
    assert.equal(post.body.get("lifetime_budget"), null, "ABO scaler must carry NO campaign budget");
    // Meta REQUIRES this to be false on a campaign with no campaign-level budget.
    assert.equal(post.body.get("is_adset_budget_sharing_enabled"), "false");
    // On ABO, bid strategy lives on the AD SET, not the campaign — Meta rejects a campaign-level
    // strategy with no campaign budget. The no-bid-cap guarantee is upheld by `createAdSet`'s
    // LOWEST_COST_WITHOUT_CAP default on every ad set the graduate mints.
    assert.equal(post.body.get("bid_strategy"), null, "ABO campaigns must not carry a bid strategy");
    // ASC is DEAD on Graph v24.0+ — minting one throws (#100/2490568) and blocked every
    // graduate. These two knobs must never go on the wire again.
    assert.equal(post.body.get("smart_promotion_type"), null, "ASC is rejected by Graph v24.0+");
    assert.equal(post.body.get("existing_customer_budget_percentage"), null, "ASC-only knob");
  } finally {
    stub.restore();
  }
});

test("coldScalerCampaignName — product-titled, pairing with the testing campaign", () => {
  assert.equal(
    coldScalerCampaignName("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "Superfood Tabs"),
    "MB — Superfood Tabs Scaler (ABO)",
    "must pair with 'MB — Superfood Tabs Testing (ABO)' so a human can see the pair in Ads Manager",
  );
  // Falls back to the cohort-id form when the product cannot be resolved.
  assert.equal(coldScalerCampaignName("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"), "MB — Cold Scaler (aaaaaaaa)");
  assert.equal(coldScalerCampaignName("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "   "), "MB — Cold Scaler (aaaaaaaa)");
});

test("getOrCreateTestingCampaign — idempotent by name across two calls", async () => {
  let campaignRows: Array<{ id: string; name: string; status: string }> = [];
  const stub = stubFetch((call) => {
    if (call.method === "GET" && call.url.includes("/act_9999/campaigns")) {
      return { json: { data: campaignRows } };
    }
    if (call.method === "POST" && call.url.includes("/act_9999/campaigns")) {
      const created = { id: "mb-testing-abo-1", name: MB_TESTING_CAMPAIGN_NAME, status: "PAUSED" };
      campaignRows = [...campaignRows, created];
      return { json: { id: created.id } };
    }
    throw new Error(`unexpected call: ${call.method} ${call.url}`);
  });
  try {
    const first = await getOrCreateTestingCampaign("token", "act_9999");
    const second = await getOrCreateTestingCampaign("token", "act_9999");
    assert.equal(first, "mb-testing-abo-1");
    assert.equal(second, first, "second call must return the same campaign id");
    const posts = stub.calls.filter((c) => c.method === "POST");
    assert.equal(posts.length, 1, "second call must NOT POST a new campaign");
  } finally {
    stub.restore();
  }
});
