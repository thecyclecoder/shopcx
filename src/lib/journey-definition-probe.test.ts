/**
 * Unit tests pinning the journey-definition activity probe (Phase 3 of
 * review-request-sol-session). We build a tiny mock Supabase surface that
 * captures the query shape + returns fixture rows — no live DB required.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  PRODUCT_REVIEW_JOURNEY_SLUG,
  assertJourneyDefinitionActive,
  assertProductReviewJourneyActive,
} from "./journey-definition-probe";

type ProbedQuery = {
  workspaceId: string | null;
  slug: string | null;
};

function makeAdmin(row: { id: string; is_active: boolean } | null) {
  const probed: ProbedQuery = { workspaceId: null, slug: null };
  const chain = {
    select: () => chain,
    eq(col: string, val: string) {
      if (col === "workspace_id") probed.workspaceId = val;
      if (col === "slug") probed.slug = val;
      return chain;
    },
    maybeSingle: async () => ({ data: row, error: null }),
  };
  return {
    admin: { from: () => chain } as unknown as Parameters<
      typeof assertJourneyDefinitionActive
    >[0],
    probed,
  };
}

test("PRODUCT_REVIEW_JOURNEY_SLUG matches the seed migration's literal", () => {
  assert.equal(PRODUCT_REVIEW_JOURNEY_SLUG, "product-review");
});

test("assertJourneyDefinitionActive — returns active + id on an is_active row", async () => {
  const { admin, probed } = makeAdmin({ id: "jd-1", is_active: true });
  const r = await assertJourneyDefinitionActive(admin, "ws-1", "product-review");
  assert.equal(r.active, true);
  if (r.active) assert.equal(r.journeyId, "jd-1");
  assert.equal(probed.workspaceId, "ws-1");
  assert.equal(probed.slug, "product-review");
});

test("assertJourneyDefinitionActive — returns inactive on is_active=false", async () => {
  const { admin } = makeAdmin({ id: "jd-1", is_active: false });
  const r = await assertJourneyDefinitionActive(admin, "ws-1", "product-review");
  assert.equal(r.active, false);
  if (!r.active) assert.equal(r.reason, "inactive");
});

test("assertJourneyDefinitionActive — returns not_found on a missing row", async () => {
  const { admin } = makeAdmin(null);
  const r = await assertJourneyDefinitionActive(admin, "ws-1", "product-review");
  assert.equal(r.active, false);
  if (!r.active) assert.equal(r.reason, "not_found");
});

test("assertJourneyDefinitionActive — refuses an empty workspaceId / slug (short-circuits before DB)", async () => {
  const { admin: a1 } = makeAdmin({ id: "jd-1", is_active: true });
  const r1 = await assertJourneyDefinitionActive(a1, "", "product-review");
  assert.equal(r1.active, false);
  const { admin: a2 } = makeAdmin({ id: "jd-1", is_active: true });
  const r2 = await assertJourneyDefinitionActive(a2, "ws-1", "");
  assert.equal(r2.active, false);
});

test("assertProductReviewJourneyActive — uses the pinned slug (fat-finger guard)", async () => {
  const { admin, probed } = makeAdmin({ id: "jd-1", is_active: true });
  const r = await assertProductReviewJourneyActive(admin, "ws-1");
  assert.equal(r.active, true);
  assert.equal(probed.slug, "product-review");
});
