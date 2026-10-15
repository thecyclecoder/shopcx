/**
 * Pre-insert UUID guard for `storefront_experiments` writes (`invalidExperimentIdsReason`, wired
 * into `materializeCampaign` + `proposeRenewalOfferCampaign`). Ground truth: a test fixture's
 * "P-1" product_id reached production as an INSERT and failed with
 * `invalid input syntax for type uuid` on every run. A non-UUID id must be skipped with a
 * reason and never reach the DB client.
 *
 * Built-in node:test — run:
 *   npx tsx --test src/lib/storefront/experiment-id-guard.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  invalidExperimentIdsReason,
  materializeCampaign,
  proposeRenewalOfferCampaign,
} from "./optimizer-agent";

const WS = "11111111-1111-4111-8111-111111111111";
const PRODUCT = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";

/** An admin client that fails the test if anything touches it. */
const untouchableAdmin = new Proxy(
  {},
  {
    get(_t, prop) {
      throw new Error(`DB client touched (.${String(prop)}) — the guard should have refused first`);
    },
  },
) as never;

test("invalidExperimentIdsReason passes real UUIDs (created_by optional)", () => {
  assert.equal(invalidExperimentIdsReason({ workspaceId: WS, productId: PRODUCT, createdBy: USER }), null);
  assert.equal(invalidExperimentIdsReason({ workspaceId: WS, productId: PRODUCT, createdBy: null }), null);
  assert.equal(invalidExperimentIdsReason({ workspaceId: WS, productId: PRODUCT }), null);
});

test("invalidExperimentIdsReason names each non-UUID field", () => {
  const r = invalidExperimentIdsReason({ workspaceId: WS, productId: "P-1" });
  assert.ok(r);
  assert.match(r, /product_id="P-1"/);
  assert.doesNotMatch(r, /workspace_id/);

  const r2 = invalidExperimentIdsReason({ workspaceId: "ws-1", productId: "8012345678901", createdBy: "box" });
  assert.ok(r2);
  assert.match(r2, /workspace_id="ws-1"/);
  assert.match(r2, /product_id="8012345678901"/); // a shopify_* id is not an internal id
  assert.match(r2, /created_by="box"/);

  assert.ok(invalidExperimentIdsReason({ workspaceId: WS, productId: "" }));
});

test("materializeCampaign refuses a non-UUID product_id before touching the DB", async () => {
  const res = await materializeCampaign({
    admin: untouchableAdmin,
    workspaceId: WS,
    productId: "P-1",
    conservative: true,
    initialStatus: "draft",
    proposal: {
      hypothesis: "h",
      reasoning: "r",
      lever_key: "winner_lander_match",
      lever_class: "reversible",
      lander_type: "advertorial",
      audience: "all",
      variant: { label: "v", kind: "content", patch: { headline: "x" } },
    },
  });
  assert.equal(res.ok, false);
  assert.match(res.detail, /product_id="P-1"/);
});

test("proposeRenewalOfferCampaign refuses a non-UUID created_by before touching the DB", async () => {
  const res = await proposeRenewalOfferCampaign({
    admin: untouchableAdmin,
    workspaceId: WS,
    productId: PRODUCT,
    createdBy: "P-1",
    conservative: true,
    floorPct: 0.4,
    proposal: {
      hypothesis: "h",
      reasoning: "r",
      lever_key: "renewal_offer",
      lever_class: "offer",
      lander_type: "pdp",
      audience: "all",
      variant: {
        label: "renewal-offer",
        kind: "offer",
        offer: { offer_type: "subscribe_discount_pct", subscribe_discount_pct: 20, ends_at: "2099-01-01T00:00:00Z" },
      },
    },
  });
  assert.equal(res.ok, false);
  assert.equal(res.margin, null);
  assert.match(res.detail, /created_by="P-1"/);
});
