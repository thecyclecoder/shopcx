/**
 * select-angle-pattern tests — pin the Phase-1 selector's contract:
 *   (i)   a warm-only pattern is refused for a cold brief
 *   (ii)  a pattern whose `consumes` list needs `offer` is refused for a cold brief
 *         (temperature-keyed offer rule — cold ads carry no offer)
 *   (iii) an empty palette returns null (caller falls back to the pre-M1 inlined path)
 *
 * Stubs at the admin.from(...) layer so the real angle-palette / headline-patterns
 * SDK filters run — same shape as angle-demand-sweep.test.ts.
 *
 * Run: npx tsx --test src/lib/ads/select-angle-pattern.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import { selectAnglePatternForBrief } from "./select-angle-pattern";

/**
 * Build the `admin.from(table).select().eq()....order()` chain shape that both
 * listAnglePalette and listHeadlinePatterns exercise. The builder is thenable so
 * the caller can chain any of {.eq, .order} in any order and terminate with an
 * `await`. Terminal await resolves to `{ data, error }` from whichever row set
 * matches the table. Matches the real PostgrestFilterBuilder shape enough for a
 * pure-unit test.
 */
function makeFakeAdmin(rowsByTable: Record<string, unknown[]>) {
  return {
    from(table: string) {
      const rows = rowsByTable[table] ?? [];
      const result = { data: rows, error: null as null };
      const builder: {
        select: (cols?: string) => typeof builder;
        eq: (col: string, val: unknown) => typeof builder;
        order: (col: string, opts?: unknown) => typeof builder;
        then: <TResult>(
          onFulfilled: (value: { data: unknown[]; error: null }) => TResult,
        ) => Promise<TResult>;
      } = {
        select() {
          return builder;
        },
        eq() {
          return builder;
        },
        order() {
          return builder;
        },
        then(onFulfilled) {
          return Promise.resolve(result).then(onFulfilled);
        },
      };
      return builder;
    },
  };
}

/**
 * A palette row with enemy + mechanism populated so a cold "villain-callout"
 * (consumes: ['enemy','mechanism']) is legal, but any 'offer'-consuming pattern
 * must still be refused for cold by the picker's temperature rule.
 */
const anglePaletteRow = {
  id: "angle-1",
  workspace_id: "ws-1",
  product_id: "prod-1",
  theme: "beauty",
  problem: "aging skin",
  ingredients: ["collagen"],
  benefit_key: null,
  enemy: "serums that sit on the surface",
  mechanism: "drinkable collagen",
  desired_outcome: "smoother skin",
  proof_text: null,
  proof_kind: null,
  evidence_tier: "science_strong",
  backing_review_ids: [],
  search_demand: "high",
  awareness_stages: ["cold", "warm"],
  source: "seeded",
  times_used: 0,
  last_used_at: null,
  status: "fresh",
  is_active: true,
  display_order: 1,
  notes: null,
};

const warmOnlyPatternRow = {
  id: "pat-warm-1",
  slug: "social-proof",
  name: "Social proof",
  structure: "[N] people quietly [switched].",
  awareness_stages: ["warm", "hot"],
  consumes: ["proof", "outcome"],
  example: null,
  is_active: true,
  display_order: 8,
};

const coldOfferPatternRow = {
  id: "pat-offer-1",
  slug: "offer",
  name: "Offer",
  structure: "[OFFER] on the [PRODUCT] that [OUTCOME].",
  // deliberately marked cold-legal in this fixture to prove the picker's OWN
  // temperature-keyed offer gate refuses it — not just the SDK's stage filter
  awareness_stages: ["cold"],
  consumes: ["offer", "product", "outcome"],
  example: null,
  is_active: true,
  display_order: 99,
};

const coldReframePatternRow = {
  id: "pat-cold-1",
  slug: "reframe",
  name: "Reframe",
  structure: "[SUBJECT] doesn't need more [ENEMY]. It needs [MECHANISM].",
  awareness_stages: ["cold"],
  consumes: ["subject", "enemy", "mechanism"],
  example: null,
  is_active: true,
  display_order: 1,
};

test("(i) a warm-only pattern is refused for a cold brief → returns null", async () => {
  const admin = makeFakeAdmin({
    product_angle_palette: [anglePaletteRow],
    ad_headline_patterns: [warmOnlyPatternRow],
  });
  const out = await selectAnglePatternForBrief({
    admin: admin as never,
    workspaceId: "ws-1",
    productId: "prod-1",
    temperature: "cold",
  });
  assert.equal(out, null, "warm-only pattern must not be picked for a cold brief");
});

test("(ii) a pattern whose consumes needs 'offer' is refused when temperature is cold", async () => {
  const admin = makeFakeAdmin({
    product_angle_palette: [anglePaletteRow],
    ad_headline_patterns: [coldOfferPatternRow],
  });
  const out = await selectAnglePatternForBrief({
    admin: admin as never,
    workspaceId: "ws-1",
    productId: "prod-1",
    temperature: "cold",
  });
  assert.equal(
    out,
    null,
    "cold ads carry no offer — a pattern whose consumes list includes 'offer' must be refused",
  );
});

test("(iii) an empty palette → returns null (caller falls back to pre-M1 inlined path)", async () => {
  const admin = makeFakeAdmin({
    product_angle_palette: [],
    ad_headline_patterns: [coldReframePatternRow],
  });
  const out = await selectAnglePatternForBrief({
    admin: admin as never,
    workspaceId: "ws-1",
    productId: "prod-1",
    temperature: "cold",
  });
  assert.equal(out, null, "empty palette must return null, not throw");
});

test("happy path — cold brief with an enemy/mechanism angle picks the cold reframe pattern", async () => {
  const admin = makeFakeAdmin({
    product_angle_palette: [anglePaletteRow],
    ad_headline_patterns: [coldOfferPatternRow, coldReframePatternRow],
  });
  const out = await selectAnglePatternForBrief({
    admin: admin as never,
    workspaceId: "ws-1",
    productId: "prod-1",
    temperature: "cold",
  });
  assert.ok(out, "picker must find a legal (angle, pattern) pair");
  assert.equal(out?.angle.id, "angle-1");
  assert.equal(out?.pattern.slug, "reframe", "must skip the offer-consuming pattern and pick reframe");
  assert.equal(out?.theme, "beauty");
});
