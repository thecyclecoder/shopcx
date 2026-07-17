/**
 * Unit tests for creative-agent pure helpers:
 *   1. `readyStatusForAngle` — dahlia-creative-requires-angle-before-ready Phase 1 guard.
 *   2. `briefHasFaithfulPackshot` + `planCompositionTransfer` — ad-creative-requires-real-packshot-
 *      never-invent-packaging Phase 1: composition transfer may only run when the brief carries a
 *      faithful packshot; otherwise the generation is SKIPPED (never silently falls through to a
 *      competitor-only image set, where Nano Banana fabricates a plausible-looking pack from the
 *      brand name — the 2026-07-14 Ashwavana Zen Relax pink-pouch / red-box regression).
 *
 * Built-in node:test — no runner dep. Run:
 *   npx tsx --test src/lib/ads/creative-agent.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { CreativeBrief, ScoredAngle } from "@/lib/ads/creative-brief";
import { readyStatusForAngle, briefHasFaithfulPackshot, planCompositionTransfer, buildAngleProvenance } from "./creative-agent";

test("readyStatusForAngle holds a null angle out of 'ready'", () => {
  assert.equal(readyStatusForAngle(null), "draft");
  assert.equal(readyStatusForAngle(undefined), "draft");
  assert.equal(readyStatusForAngle(""), "draft");
});

test("readyStatusForAngle lets a resolved angle land at 'ready'", () => {
  assert.equal(readyStatusForAngle("angle-uuid"), "ready");
});

// ── ad-creative-requires-real-packshot-never-invent-packaging Phase 1 ────────────

function briefWith(imageRefs: CreativeBrief["imageRefs"]): Pick<CreativeBrief, "imageRefs"> {
  return { imageRefs };
}

function competitorAngle(imageUrl?: string): Pick<ScoredAngle, "source" | "raw"> {
  return { source: "competitor", raw: imageUrl ? { imageUrl } : undefined };
}

function ownAngle(): Pick<ScoredAngle, "source" | "raw"> {
  return { source: "review_cluster", raw: undefined };
}

test("briefHasFaithfulPackshot: true only when a role:'packshot' ref carries a real URL", () => {
  assert.equal(briefHasFaithfulPackshot(briefWith([{ role: "packshot", url: "https://cdn.example/pack.jpg" }])), true);
  assert.equal(briefHasFaithfulPackshot(briefWith([{ role: "hero", url: "https://cdn.example/hero.jpg" }])), false);
  assert.equal(briefHasFaithfulPackshot(briefWith([])), false);
  // A packshot slot without a URL doesn't count — nothing for the generator to composition-transfer against.
  assert.equal(briefHasFaithfulPackshot(briefWith([{ role: "packshot", url: "" }])), false);
  // A relative storage path can't be fetched by Gemini — creative-generate already filters these; the guard
  // matches the same predicate so a brief carrying only an unfetchable pack ref is treated as packshot-less.
  assert.equal(briefHasFaithfulPackshot(briefWith([{ role: "packshot", url: "media/pack.jpg" }])), false);
  // data: URIs are the acceptable non-http shape creative-generate also honors.
  assert.equal(briefHasFaithfulPackshot(briefWith([{ role: "packshot", url: "data:image/png;base64,AAA" }])), true);
});

test("planCompositionTransfer: own-brand angle runs with useCompositionTransfer=false (unchanged behavior)", () => {
  const plan = planCompositionTransfer(ownAngle(), briefWith([{ role: "hero", url: "https://cdn.example/hero.jpg" }]));
  assert.equal(plan.kind, "run");
  if (plan.kind === "run") {
    assert.equal(plan.useCompositionTransfer, false);
    assert.equal(plan.designReferenceUrl, undefined);
  }
});

test("planCompositionTransfer: competitor angle with NO refUrl runs plain (no composition transfer, nothing to gate)", () => {
  const plan = planCompositionTransfer(competitorAngle(undefined), briefWith([]));
  assert.equal(plan.kind, "run");
  if (plan.kind === "run") assert.equal(plan.useCompositionTransfer, false);
});

test("planCompositionTransfer: competitor angle + refUrl but NO packshot in brief → SKIP (packshot_missing)", () => {
  const plan = planCompositionTransfer(
    competitorAngle("https://competitor.example/winning.jpg"),
    briefWith([{ role: "hero", url: "https://cdn.example/hero.jpg" }]),
  );
  assert.equal(plan.kind, "skip");
  if (plan.kind === "skip") assert.equal(plan.reason, "packshot_missing");
});

test("planCompositionTransfer: competitor angle + refUrl + packshot ref → RUN with composition transfer", () => {
  const plan = planCompositionTransfer(
    competitorAngle("https://competitor.example/winning.jpg"),
    briefWith([
      { role: "hero", url: "https://cdn.example/hero.jpg" },
      { role: "packshot", url: "https://cdn.example/pack.jpg" },
    ]),
  );
  assert.equal(plan.kind, "run");
  if (plan.kind === "run") {
    assert.equal(plan.useCompositionTransfer, true);
    assert.equal(plan.designReferenceUrl, "https://competitor.example/winning.jpg");
  }
});

test("planCompositionTransfer: NEVER silently falls through to competitor-only when packshot missing (the exact regression this spec closes)", () => {
  // Two competitor angles with two different winning graphics — both must skip; NEITHER may run
  // composition-transfer against ONLY the competitor image (which is what let Nano Banana fabricate
  // a pink pouch in one draft and a red box in another on 2026-07-14).
  const packshotless = briefWith([{ role: "hero", url: "https://cdn.example/hero.jpg" }]);
  for (const graphic of ["https://competitor.example/a.jpg", "https://competitor.example/b.jpg"]) {
    const plan = planCompositionTransfer(competitorAngle(graphic), packshotless);
    assert.equal(plan.kind, "skip");
  }
});

// ── buildAngleProvenance — explore/exploit source reference on the read-only detail page ─────────

function scoredAngle(over: Partial<ScoredAngle>): ScoredAngle {
  return {
    hook: "results-first hook",
    source: "review_cluster",
    leadBenefit: "clearer focus by week two",
    acquisitionPower: 6,
    retentionTruth: 7,
    commodity: false,
    hasRealPhoto: false,
    reasons: [],
    raw: undefined,
    ...over,
  };
}

test("buildAngleProvenance: a competitor angle is EXPLORE — carries the advertiser + ad image + raw hook", () => {
  const p = buildAngleProvenance(
    scoredAngle({
      source: "competitor",
      hook: "our debranded benefit",
      raw: { advertiser: "MUD\\WTR", imageUrl: "https://competitor.example/winning.jpg", hook: "Ditch coffee for good" },
    }),
  );
  assert.equal(p.mode, "explore");
  assert.equal(p.source, "competitor");
  assert.equal(p.competitor_advertiser, "MUD\\WTR");
  assert.equal(p.competitor_ad_image_url, "https://competitor.example/winning.jpg");
  assert.equal(p.competitor_hook, "Ditch coffee for good");
});

test("buildAngleProvenance: a competitor angle with no raw hook falls back to the angle's own hook", () => {
  const p = buildAngleProvenance(scoredAngle({ source: "competitor", hook: "fallback hook", raw: { advertiser: "Ryze" } }));
  assert.equal(p.competitor_hook, "fallback hook");
  assert.equal(p.competitor_ad_image_url, null);
});

test("buildAngleProvenance: an own-brand angle is EXPLOIT — no competitor fields leak", () => {
  const p = buildAngleProvenance(scoredAngle({ source: "transformation", raw: { advertiser: "should-be-ignored", imageUrl: "x" } }));
  assert.equal(p.mode, "exploit");
  assert.equal(p.source, "transformation");
  assert.equal(p.competitor_advertiser, null);
  assert.equal(p.competitor_ad_image_url, null);
  assert.equal(p.competitor_hook, null);
  assert.equal(p.lead_benefit, "clearer focus by week two");
});
