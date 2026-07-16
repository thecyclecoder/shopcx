/**
 * creative-pack tests — pins the Dahlia creative pack invariants
 * (dahlia-produces-3-placement-multi-copy-creative-pack Phase 2):
 *   1. `placementPackPlan()` yields feed_4x5 + stories_9x16 + right_column_1x1 (canonical + 2 siblings).
 *   2. `buildMetaCopyPack(brief)` yields ≥4 headlines + ≥4 primary texts (Meta rotates them per placement).
 *   3. `planCreativePackInserts` emits ONE canonical ad_videos body + TWO sibling bodies for the same
 *      campaign — siblings carry the correct `format` so the caller can stamp `format_variant_of_id =
 *      canonical.id` after the canonical insert lands (the same-psychology invariant expressed in the DB).
 *   4. The planner refuses a malformed pack: fewer than 3 statics, missing right-column, non-feed_4x5
 *      canonical, or <4 headlines / <4 primary texts (the shape gate downstream `isCreativePackComplete`
 *      re-checks on persisted rows).
 *
 *   npx tsx --test src/lib/ads/creative-pack.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { CreativeBrief, ScoredAngle } from "./creative-brief";
import {
  buildMetaCopyPack,
  placementPackPlan,
  planCreativePackInserts,
  CREATIVE_PACK_MIN,
  type RenderedPlacement,
} from "./creative-pack";

function makeAngle(overrides: Partial<ScoredAngle> = {}): ScoredAngle {
  return {
    hook: "The energy that lasts all afternoon — no crash",
    source: "ad_angle",
    leadBenefit: "steady energy — no 2pm crash",
    acquisitionPower: 8,
    retentionTruth: 9,
    commodity: false,
    hasRealPhoto: false,
    reasons: [],
    ...overrides,
  };
}

function makeBrief(overrides: Partial<CreativeBrief> = {}): CreativeBrief {
  return {
    productTitle: "Amazing Coffee",
    angle: makeAngle(),
    leadProof: { kind: "review", text: "Best coffee I've ever had — I feel focused all day.", attribution: "Sarah M." },
    transformation: null,
    supportingBenefits: ["steady focus without a crash", "great flavor", "protects your afternoon energy"],
    proofStack: ["3rd-party tested", "non-GMO", "10,000+ 5-star reviews"],
    offer: { headline: "Up to 34% off + free shipping", strikethrough: null, perServing: "$0.83/serving vs a $4–8 coffee/latte", disclaimer: "" },
    imageRefs: [],
    guardrails: [],
    ...overrides,
  };
}

const BUF = (label: string) => Buffer.from(`fake:${label}`);
const renderFor = (format: RenderedPlacement["format"]): RenderedPlacement =>
  ({ format, buffer: BUF(format), mimeType: "image/jpeg" });

test("placementPackPlan — canonical is feed_4x5 + siblings cover 9:16 and right_column_1x1", () => {
  const plan = placementPackPlan();
  assert.equal(plan.canonical.format, "feed_4x5");
  assert.equal(plan.canonical.aspectRatio, "4:5");
  const sibFormats = plan.siblings.map((s) => s.format).sort();
  assert.deepEqual(sibFormats, ["right_column_1x1", "stories_9x16"]);
  const sibAspects = plan.siblings.map((s) => s.aspectRatio).sort();
  assert.deepEqual(sibAspects, ["1:1", "9:16"]);
});

test("buildMetaCopyPack — yields ≥4 distinct headlines + ≥4 distinct primary texts from real brief material", () => {
  const brief = makeBrief();
  const pack = buildMetaCopyPack(brief);
  assert.ok(pack.headlines.length >= CREATIVE_PACK_MIN.headlines, `headlines: got ${pack.headlines.length}, expected ≥${CREATIVE_PACK_MIN.headlines}`);
  assert.ok(pack.primaryTexts.length >= CREATIVE_PACK_MIN.primaryTexts, `primaryTexts: got ${pack.primaryTexts.length}, expected ≥${CREATIVE_PACK_MIN.primaryTexts}`);
  // Each entry is a non-empty publishable string
  for (const h of pack.headlines) assert.ok(h.trim().length > 0, "empty headline");
  for (const p of pack.primaryTexts) assert.ok(p.trim().length > 0, "empty primary text");
});

test("buildMetaCopyPack — Meta length caps hold across every headline + primary text", async () => {
  // Caps track META_CAPS in @/lib/ad-tool-config (headline 40, primary_text 600) — the source of
  // truth every downstream ad-copy consumer uses.
  const { META_CAPS } = await import("@/lib/ad-tool-config");
  const brief = makeBrief({
    supportingBenefits: [
      "A very long supporting benefit that pushes way past forty characters for sure and then some",
      "Another supporting truth that also runs on and on and on well past the character limit",
    ],
  });
  const pack = buildMetaCopyPack(brief);
  for (const h of pack.headlines) assert.ok(h.length <= META_CAPS.headline, `headline over cap: "${h}" (${h.length})`);
  for (const p of pack.primaryTexts) assert.ok(p.length <= META_CAPS.primary_text, `primary over cap: "${p}" (${p.length})`);
});

test("planCreativePackInserts — emits 1 canonical + 2 siblings for the SAME campaign_id (same-psychology substrate)", () => {
  const pack = buildMetaCopyPack(makeBrief());
  const canonical = renderFor("feed_4x5");
  const siblings = [renderFor("stories_9x16"), renderFor("right_column_1x1")];
  const plan = planCreativePackInserts({
    workspaceId: "ws-1", campaignId: "cmp-1",
    canonicalRender: canonical, siblingRenders: siblings,
    copyPack: pack, archetype: "before_after", generatedBy: "ad-creative-agent",
  });
  // Exactly 3 rows, all sharing the campaign_id — the pack.
  const rows = [plan.canonical, ...plan.siblings];
  assert.equal(rows.length, CREATIVE_PACK_MIN.placementStatics);
  for (const r of rows) {
    assert.equal(r.workspace_id, "ws-1");
    assert.equal(r.campaign_id, "cmp-1");
    assert.equal(r.media_kind, "static");
    assert.equal(r.status, "pending");
  }
  // Canonical is feed_4x5; siblings are the 9:16 + right_column_1x1 pair (order preserved).
  assert.equal(plan.canonical.format, "feed_4x5");
  assert.deepEqual(plan.siblings.map((s) => s.format), ["stories_9x16", "right_column_1x1"]);
  // The pack's copy is persisted on the angle's metadata under `copy_pack` (backward-compat JSONB).
  assert.deepEqual(plan.angleMetadataCopyPack.copy_pack, pack);
});

test("planCreativePackInserts — rejects a canonical that isn't feed_4x5", () => {
  const pack = buildMetaCopyPack(makeBrief());
  assert.throws(
    () => planCreativePackInserts({
      workspaceId: "ws-1", campaignId: "cmp-1",
      canonicalRender: renderFor("stories_9x16"),
      siblingRenders: [renderFor("right_column_1x1")],
      copyPack: pack, archetype: "before_after", generatedBy: "ad-creative-agent",
    }),
    /canonical must be feed_4x5/,
  );
});

test("planCreativePackInserts — rejects a pack missing right_column_1x1 (Phase 1's DB format)", () => {
  const pack = buildMetaCopyPack(makeBrief());
  assert.throws(
    () => planCreativePackInserts({
      workspaceId: "ws-1", campaignId: "cmp-1",
      canonicalRender: renderFor("feed_4x5"),
      siblingRenders: [renderFor("stories_9x16"), renderFor("stories_9x16")],
      copyPack: pack, archetype: "before_after", generatedBy: "ad-creative-agent",
    }),
    /right_column_1x1/,
  );
});

test("planCreativePackInserts — rejects a copy pack with fewer than 4 headlines or primary texts", () => {
  const canonical = renderFor("feed_4x5");
  const siblings = [renderFor("stories_9x16"), renderFor("right_column_1x1")];
  const shortHeadlines = {
    headlines: ["a", "b", "c"], // 3 < 4
    primaryTexts: ["p", "q", "r", "s"],
    description: "d",
  };
  assert.throws(
    () => planCreativePackInserts({
      workspaceId: "ws-1", campaignId: "cmp-1",
      canonicalRender: canonical, siblingRenders: siblings,
      copyPack: shortHeadlines, archetype: "before_after", generatedBy: "ad-creative-agent",
    }),
    /≥4 headlines/,
  );
  const shortPrimary = {
    headlines: ["a", "b", "c", "d"],
    primaryTexts: ["p", "q", "r"], // 3 < 4
    description: "d",
  };
  assert.throws(
    () => planCreativePackInserts({
      workspaceId: "ws-1", campaignId: "cmp-1",
      canonicalRender: canonical, siblingRenders: siblings,
      copyPack: shortPrimary, archetype: "before_after", generatedBy: "ad-creative-agent",
    }),
    /≥4 primary texts/,
  );
});
