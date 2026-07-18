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
import { readyStatusForAngle, briefHasFaithfulPackshot, planCompositionTransfer, buildAngleProvenance, imageOfferForAudience, resolveAudienceTemperature, markPureCompetitorMinoritySlot, validateCopyParagraphStructure, PARAGRAPH_CLOSE_MAX_WORDS, validateCopyHumanVoice, formatHumanVoiceLocation, EM_DASH, EN_DASH } from "./creative-agent";

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

// ── imageOfferForAudience — cold creatives render NO offer on the image (2026-07-17) ─────────────
const SAMPLE_OFFER = { headline: "Save 20%", strikethrough: "$40 → $32", perServing: "$1.07/serving", disclaimer: "while supplies last" };

test("imageOfferForAudience: a COLD angle (competitor) strips the offer to null", () => {
  assert.equal(imageOfferForAudience({ source: "competitor", acquisitionPower: 5 }, SAMPLE_OFFER), null);
});

test("imageOfferForAudience: a COLD angle (acquisitionPower >= 8) strips the offer to null", () => {
  assert.equal(imageOfferForAudience({ source: "review_cluster", acquisitionPower: 9 }, SAMPLE_OFFER), null);
});

test("imageOfferForAudience: a WARM angle passes the offer through unchanged", () => {
  const warm = { source: "review_cluster" as const, acquisitionPower: 4 };
  assert.equal(resolveAudienceTemperature(warm), "warm");
  assert.deepEqual(imageOfferForAudience(warm, SAMPLE_OFFER), SAMPLE_OFFER);
});

test("imageOfferForAudience: a null offer stays null regardless of temperature", () => {
  assert.equal(imageOfferForAudience({ source: "competitor", acquisitionPower: 5 }, null), null);
  assert.equal(imageOfferForAudience({ source: "review_cluster", acquisitionPower: 3 }, null), null);
});

// ── markPureCompetitorMinoritySlot — Phase 2 RIFF minority-slot allocator ────────────────────────
// dahlia-hooks-riff-competitor-angle-and-weave-in-lead-benefit Phase 2 — the batch's
// competitor-source slots default to RIFFs (lead benefit woven into the competitor angle).
// AT MOST ONE per batch is reserved as a pure-competitor explore for learning, and only when
// there are ≥2 competitor slots so the minority slot never crowds out the anchor riffs.

type Slot = { angle: Pick<ScoredAngle, "source">; pureCompetitor?: boolean };
const c = (): Slot => ({ angle: { source: "competitor" } });
const own = (src: ScoredAngle["source"] = "transformation"): Slot => ({ angle: { source: src } });

test("markPureCompetitorMinoritySlot: no competitor slots → unchanged (own-brand batch is riff-agnostic)", () => {
  const plan: Slot[] = [own("transformation"), own("ad_angle"), own("review_cluster")];
  markPureCompetitorMinoritySlot(plan);
  assert.ok(plan.every((s) => !s.pureCompetitor));
});

test("markPureCompetitorMinoritySlot: exactly ONE competitor slot → NOT flagged (the strong default is riff, not pure)", () => {
  const plan: Slot[] = [own("transformation"), c(), own("ad_angle")];
  markPureCompetitorMinoritySlot(plan);
  const compSlots = plan.filter((s) => s.angle.source === "competitor");
  assert.equal(compSlots.length, 1);
  assert.equal(compSlots[0].pureCompetitor, undefined, "the single competitor slot must riff, not go pure");
});

test("markPureCompetitorMinoritySlot: ≥2 competitor slots → only the LAST is flagged pure (top-ranked riff leads the pool)", () => {
  const plan: Slot[] = [c(), own("ad_angle"), c(), c()];
  markPureCompetitorMinoritySlot(plan);
  // The first two competitor slots stay riff (undefined); only the last is flagged pure.
  assert.equal(plan[0].pureCompetitor, undefined, "first competitor slot must be a riff");
  assert.equal(plan[2].pureCompetitor, undefined, "middle competitor slot must be a riff");
  assert.equal(plan[3].pureCompetitor, true, "only the LAST competitor slot is the minority pure slot");
  // At most ONE per batch — the invariant Phase 2 pins.
  assert.equal(plan.filter((s) => s.pureCompetitor).length, 1);
});

test("markPureCompetitorMinoritySlot: 2 competitor slots → the second (last) is flagged pure, the first is the anchor riff", () => {
  const plan: Slot[] = [c(), c()];
  markPureCompetitorMinoritySlot(plan);
  assert.equal(plan[0].pureCompetitor, undefined);
  assert.equal(plan[1].pureCompetitor, true);
});

// ── dahlia-long-form-3-paragraph-primary-text-in-human-voice Phase 1 ────────────

test("validateCopyParagraphStructure: a proper long-form 3-paragraph text passes", () => {
  const primary = [
    "Everyone said cut the coffee. She did the opposite.",
    "",
    "Barbara dropped 40 pounds the year she swapped her regular cup for Amazing Coffee, a real coffee roasted with six functional mushrooms and grass-fed collagen that 700,000 people quietly reach for every morning. No crash, no jitter, no afternoon dip.",
    "",
    "See what a different cup can do.",
  ].join("\n");
  const result = validateCopyParagraphStructure(primary);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.ok(result.hookWords > 0);
    assert.ok(result.bodyWords > result.hookWords, "body should be longer than hook");
    assert.ok(result.closeWords <= PARAGRAPH_CLOSE_MAX_WORDS);
  }
});

test("validateCopyParagraphStructure: a one-line blob fails not_three_paragraphs", () => {
  const blob = "Try Amazing Coffee — feel lighter, no jitters, all-day focus.";
  const result = validateCopyParagraphStructure(blob);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "not_three_paragraphs");
    assert.equal(result.paragraphCount, 1);
  }
});

test("validateCopyParagraphStructure: a 2-paragraph shape fails not_three_paragraphs", () => {
  const twoPara = [
    "Everyone said cut the coffee. She did the opposite.",
    "",
    "Barbara dropped 40 pounds the year she swapped her regular cup for Amazing Coffee and told her friends. See what a different cup can do.",
  ].join("\n");
  const result = validateCopyParagraphStructure(twoPara);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "not_three_paragraphs");
    assert.equal(result.paragraphCount, 2);
  }
});

test("validateCopyParagraphStructure: a hook that isn't shorter than the body fails hook_not_shortest", () => {
  const hookHeavy = [
    "One two three four five six seven eight nine ten.",
    "",
    "One two three four five.",
    "",
    "Click here.",
  ].join("\n");
  const result = validateCopyParagraphStructure(hookHeavy);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "hook_not_shortest");
    assert.equal(result.paragraphCount, 3);
  }
});

test("validateCopyParagraphStructure: a runaway close fails close_too_long", () => {
  const runawayClose = [
    "Short hook line.",
    "",
    "This is a longer body paragraph with proof and specifics and multiple beats stacked to deliver the info that backs the hook and earns the click.",
    "",
    // 30 words — over the 25-word cap
    "One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one twenty-two twenty-three twenty-four twenty-five twenty-six twenty-seven twenty-eight twenty-nine thirty.",
  ].join("\n");
  const result = validateCopyParagraphStructure(runawayClose);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "close_too_long");
    assert.ok(result.closeWords > PARAGRAPH_CLOSE_MAX_WORDS);
  }
});

test("validateCopyParagraphStructure: single \\n between lines is a same-paragraph break (splits only on blank lines)", () => {
  // Two 'paragraphs' separated by a single \n stay as ONE paragraph — the split is on `/\n\s*\n/`.
  const singleBreak = "Line one.\nLine two.\nLine three.";
  const result = validateCopyParagraphStructure(singleBreak);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "not_three_paragraphs");
    assert.equal(result.paragraphCount, 1);
  }
});

test("validateCopyParagraphStructure: tolerates whitespace-only 'blank' lines between paragraphs", () => {
  // Real caption emitters sometimes indent a blank line with a space — the regex `\n\s*\n` covers it.
  const spacedBlank = "Everyone said cut the coffee. She did the opposite.\n   \nBarbara dropped 40 pounds the year she swapped her regular cup for Amazing Coffee, and 700,000 people rely on it every morning.\n\nSee what a different cup can do.";
  const result = validateCopyParagraphStructure(spacedBlank);
  assert.equal(result.ok, true);
});

// ── dahlia-long-form-3-paragraph-primary-text-in-human-voice Phase 2 — human-voice validator ─

const cleanVariations = [
  { framework: "lf8" as const, headline: "Feel lighter. Finally.", primaryText: "LF8 hook." },
  { framework: "schwartz" as const, headline: "Not another diet.", primaryText: "Schwartz hook." },
  { framework: "cialdini" as const, headline: "700K customers.", primaryText: "Cialdini hook." },
  { framework: "hopkins" as const, headline: "15 lbs in 3 weeks.", primaryText: "Hopkins hook." },
  { framework: "sugarman" as const, headline: "Stop dieting.", primaryText: "Sugarman hook." },
];

test("validateCopyHumanVoice: caption with NO em-dashes anywhere passes", () => {
  const result = validateCopyHumanVoice({
    headline: "Clean energy, no crash",
    primaryText: "Steady focus, all morning. No jitter, no crash, no afternoon dip.",
    description: "Adaptogens.",
    variations: cleanVariations,
  });
  assert.equal(result.ok, true);
});

test("validateCopyHumanVoice: em-dash in primaryText fails em_dash_ai_tell with the canonical location", () => {
  const result = validateCopyHumanVoice({
    headline: "Clean energy",
    primaryText: `Steady focus ${EM_DASH} no crash, no jitter.`,
    description: "Adaptogens.",
    variations: cleanVariations,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.misses.length, 1);
    assert.equal(result.misses[0].reason, "em_dash_ai_tell");
    assert.equal(result.misses[0].location.kind, "canonical");
    if (result.misses[0].location.kind === "canonical") {
      assert.equal(result.misses[0].location.field, "primaryText");
    }
    assert.match(result.misses[0].evidence, /—/);
  }
});

test("validateCopyHumanVoice: em-dash in headline is caught separately", () => {
  const result = validateCopyHumanVoice({
    headline: `Clean energy ${EM_DASH} no crash`,
    primaryText: "Steady focus, all morning.",
    description: "Adaptogens.",
    variations: cleanVariations,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.misses.length, 1);
    assert.equal(result.misses[0].location.kind, "canonical");
    if (result.misses[0].location.kind === "canonical") {
      assert.equal(result.misses[0].location.field, "headline");
    }
  }
});

test("validateCopyHumanVoice: em-dash in a variation is caught with the framework name", () => {
  const badVariations = [
    { framework: "lf8" as const, headline: `Feel lighter ${EM_DASH} finally.`, primaryText: "clean." },
    ...cleanVariations.slice(1),
  ];
  const result = validateCopyHumanVoice({
    headline: "Clean",
    primaryText: "Clean.",
    description: "Clean.",
    variations: badVariations,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.misses.length, 1);
    assert.equal(result.misses[0].location.kind, "variation");
    if (result.misses[0].location.kind === "variation") {
      assert.equal(result.misses[0].location.framework, "lf8");
      assert.equal(result.misses[0].location.field, "headline");
    }
  }
});

test("validateCopyHumanVoice: comma / period rewrite of an em-dash caption passes", () => {
  // The exact rewrite the SKILL teaches — an em-dash caption gets a comma or a period.
  const commaRewrite = validateCopyHumanVoice({
    headline: "Clean energy, no crash",
    primaryText: "Steady focus. No jitter. No crash. No afternoon dip.",
    description: "Adaptogens.",
    variations: cleanVariations,
  });
  assert.equal(commaRewrite.ok, true);
});

test("validateCopyHumanVoice: SPACED en-dash used as a sentence dash fails en_dash_as_sentence_dash", () => {
  const result = validateCopyHumanVoice({
    headline: "Clean",
    primaryText: `Steady focus ${EN_DASH} no crash.`,
    description: "Clean.",
    variations: cleanVariations,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.misses.length, 1);
    assert.equal(result.misses[0].reason, "en_dash_as_sentence_dash");
  }
});

test("validateCopyHumanVoice: UNSPACED en-dash range (e.g. a numeric or date range) passes — only sentence-dash usage is flagged", () => {
  // A `14–day` (no spaces) is a legitimate range; the validator must NOT flag it.
  const result = validateCopyHumanVoice({
    headline: `A 14${EN_DASH}day change`,
    primaryText: `Between 14${EN_DASH}day and 30${EN_DASH}day windows, results held.`,
    description: "Clean.",
    variations: cleanVariations,
  });
  assert.equal(result.ok, true);
});

test("validateCopyHumanVoice: multiple offending fields → misses list carries every hit at once (revise reason cites all)", () => {
  // Two hits — one canonical, one variation — so the caller can compose ONE revise reason
  // string that names both instead of forcing two revises for two related issues.
  const badVariations = [
    { framework: "sugarman" as const, headline: `Stop dieting ${EM_DASH} drink this.`, primaryText: "clean." },
    ...cleanVariations.slice(1),
  ];
  const result = validateCopyHumanVoice({
    headline: `Clean energy ${EM_DASH} no crash`,
    primaryText: "Clean.",
    description: "Clean.",
    variations: badVariations,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.misses.length, 2);
    // A single scan surfaces every hit — the caller composes the revise reason from the whole list.
    const locations = result.misses.map((m) => formatHumanVoiceLocation(m.location));
    assert.deepEqual(locations.sort(), ["headline", "variations[sugarman].headline"]);
  }
});

test("formatHumanVoiceLocation: canonical fields → bare field name; variation fields → variations[framework].field", () => {
  assert.equal(
    formatHumanVoiceLocation({ kind: "canonical", field: "primaryText" }),
    "primaryText",
  );
  assert.equal(
    formatHumanVoiceLocation({ kind: "canonical", field: "headline" }),
    "headline",
  );
  assert.equal(
    formatHumanVoiceLocation({ kind: "canonical", field: "description" }),
    "description",
  );
  assert.equal(
    formatHumanVoiceLocation({ kind: "variation", framework: "lf8", field: "headline" }),
    "variations[lf8].headline",
  );
  assert.equal(
    formatHumanVoiceLocation({ kind: "variation", framework: "sugarman", field: "primaryText" }),
    "variations[sugarman].primaryText",
  );
});
