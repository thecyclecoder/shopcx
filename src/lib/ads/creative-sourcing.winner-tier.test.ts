/**
 * creative-sourcing winner-tier + intent tests — pin the
 * dahlia-researches-from-winners-flow-ad-library Phase 1 invariants
 * (see docs/brain/specs/dahlia-researches-from-winners-flow-ad-library.md):
 *
 *   1. `getProvenCompetitorAngles` now SELECTS + returns the winners-flow signals
 *      (`winner_tier`, `winner_score`, `concept_tags`) as `winnerTier` /
 *      `winnerScore` / `conceptTags` on each `CompetitorAngle`.
 *   2. Returned angles are ranked by `winner_tier` (proven > building > new >
 *      retired), then `winner_score`, then `days_running`. A `retired` row NEVER
 *      leads the shelf even at high `days_running` — a competitor's killed ad is
 *      not a research base.
 *   3. When `intent.audience_temperature` is set, angles whose
 *      `concept_tags.awareness_stage` matches the temperature bucket
 *      (cold→unaware/problem_aware · warm→solution_aware/product_aware ·
 *      hot→most_aware) rank at the FRONT. Off-temperature angles fill the tail
 *      so a thin temperature-matched shelf never starves the batch (preference,
 *      not filter).
 *   4. `buildCreativeBrief` surfaces `brief.conceptTags` for a competitor angle
 *      threaded with the unified breakdown — the imitation rubric Dahlia +
 *      Max's Phase 2 grader read.
 *
 * Pure helpers — no network, no live DB. Runs via:
 *   npx tsx --test src/lib/ads/creative-sourcing.winner-tier.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  getProvenCompetitorAngles,
  rankByWinnerSignalAndIntent,
  winnerTierRank,
  awarenessStageMatchesTemperature,
  competitorTemperatureFit,
  competitorFocalIsWarmHot,
  type CompetitorAngle,
} from "./creative-sourcing";
import { buildCreativeBrief, type ScoredAngle } from "./creative-brief";
import type { createAdminClient } from "@/lib/supabase/admin";
import type { ConceptTags } from "@/lib/creative-skeleton";
import type { ProductIntelligence } from "@/lib/product-intelligence";

type Admin = ReturnType<typeof createAdminClient>;

const WS = "00000000-0000-0000-0000-0000000000ws";
const PRODUCT = "prod-cofee-winner";

interface SkeletonRow {
  workspace_id: string;
  product_id: string | null;
  status: string;
  advertiser: string | null;
  hook: string | null;
  framework: string | null;
  mechanism_claim: string | null;
  proof: string | null;
  offer: string | null;
  days_running: number | null;
  heat: number | null;
  destination_domain: string | null;
  image_url: string | null;
  resume_advertising: boolean | null;
  winner_tier: string | null;
  winner_score: number | null;
  media_type: string | null;
  concept_tags: ConceptTags | null;
  // flag-a-competitor-ad-do-not-use Phase 1 — queryProvenAngles filters `.eq('do_not_use', false)`,
  // so a mock row MUST carry the flag or it's excluded from the shelf.
  do_not_use: boolean | null;
}

function skel(over: Partial<SkeletonRow>): SkeletonRow {
  return {
    workspace_id: WS,
    product_id: PRODUCT,
    status: "analyzed",
    advertiser: "Rival Co",
    hook: "Meet Nature's Ozempic",
    framework: "hook-mech-offer",
    mechanism_claim: "coffee that curbs cravings",
    proof: "10k+ served",
    offer: "20% off",
    days_running: 40,
    heat: 4,
    destination_domain: "rivalco.com",
    image_url: "https://cdn.example/x.jpg",
    resume_advertising: true,
    winner_tier: "new",
    winner_score: 0,
    media_type: "static",
    concept_tags: null,
    do_not_use: false,
    ...over,
  };
}

function conceptTags(over: Partial<ConceptTags>): ConceptTags {
  return {
    angle: "clean energy no crash",
    archetype: "problem-agitate-solve",
    why_it_works: "the mid-day crash pattern-interrupt is instantly recognizable",
    cialdini_lever: "social_proof",
    awareness_stage: "problem_aware",
    format: "static_image",
    ...over,
  };
}

function makeAdmin(rows: SkeletonRow[]): { admin: Admin } {
  function fromCreativeSkeletons() {
    const filters: Record<string, unknown> = {};
    const notNull: string[] = [];
    let gteDays: number | null = null;
    let limitN: number | null = null;
    const builder: Record<string, unknown> = {
      select(_cols: string) {
        return builder;
      },
      eq(col: string, val: unknown) {
        filters[col] = val;
        return builder;
      },
      not(col: string, _op: string, _val: unknown) {
        notNull.push(col);
        return builder;
      },
      gte(col: string, val: number) {
        if (col === "days_running") gteDays = val;
        return builder;
      },
      or(_expr: string) {
        return builder;
      },
      order(_col: string, _opts: unknown) {
        return builder;
      },
      limit(n: number) {
        limitN = n;
        return builder;
      },
      then(resolve: (v: unknown) => void) {
        const filtered = rows.filter((r) => {
          for (const [k, v] of Object.entries(filters)) {
            if ((r as unknown as Record<string, unknown>)[k] !== v) return false;
          }
          for (const col of notNull) {
            if ((r as unknown as Record<string, unknown>)[col] == null) return false;
          }
          if (gteDays != null && (r.days_running ?? -1) < gteDays) return false;
          return true;
        });
        const ordered = [...filtered].sort((a, b) => (b.days_running ?? 0) - (a.days_running ?? 0));
        const capped = limitN != null ? ordered.slice(0, limitN) : ordered;
        resolve({ data: capped, error: null });
      },
    };
    return builder;
  }

  function fromDirectorActivity() {
    return {
      insert(_row: Record<string, unknown>) {
        return Promise.resolve({ error: null });
      },
    };
  }

  const admin = {
    from(table: string) {
      if (table === "creative_skeletons") return fromCreativeSkeletons();
      if (table === "director_activity") return fromDirectorActivity();
      throw new Error(`unexpected table: ${table}`);
    },
  } as unknown as Admin;
  return { admin };
}

// ── 1. shape — the winners-flow signals are surfaced on CompetitorAngle ─────

test("getProvenCompetitorAngles: surfaces winner_tier + winner_score + concept_tags on each angle", async () => {
  const tags = conceptTags({ angle: "clean energy no crash", archetype: "problem-agitate-solve", awareness_stage: "problem_aware" });
  const { admin } = makeAdmin([
    skel({ hook: "no crash energy", days_running: 65, resume_advertising: true, winner_tier: "proven", winner_score: 45, concept_tags: tags }),
  ]);
  const { angles } = await getProvenCompetitorAngles(admin, WS, { productId: PRODUCT, preferDeeplyProven: true, limit: 5 });
  assert.equal(angles.length, 1);
  const a = angles[0];
  assert.equal(a.winnerTier, "proven");
  assert.equal(a.winnerScore, 45);
  assert.ok(a.conceptTags, "conceptTags surfaced");
  assert.equal(a.conceptTags?.angle, "clean energy no crash");
  assert.equal(a.conceptTags?.archetype, "problem-agitate-solve");
  assert.equal(a.conceptTags?.awareness_stage, "problem_aware");
});

// ── 2. ranking — winner_tier rank > winner_score > days_running ─────────────

test("rankByWinnerSignalAndIntent: proven > building > new > retired regardless of days_running", () => {
  const mk = (hook: string, over: Partial<CompetitorAngle>): CompetitorAngle => ({
    advertiser: null,
    hook,
    framework: null,
    mechanismClaim: null,
    proof: null,
    offer: null,
    daysRunning: 30,
    heat: null,
    destinationDomain: null,
    imageUrl: null,
    resumeAdvertising: null,
    winnerTier: null,
    winnerScore: null,
    conceptTags: null,
    ...over,
  });
  const angles: CompetitorAngle[] = [
    mk("retired ad", { winnerTier: "retired", winnerScore: 200, daysRunning: 200 }),
    mk("new ad", { winnerTier: "new", winnerScore: 2, daysRunning: 30 }),
    mk("proven ad", { winnerTier: "proven", winnerScore: 45, daysRunning: 90 }),
    mk("building ad", { winnerTier: "building", winnerScore: 12, daysRunning: 45 }),
  ];
  const ranked = rankByWinnerSignalAndIntent(angles);
  assert.deepEqual(
    ranked.map((a) => a.hook),
    ["proven ad", "building ad", "new ad", "retired ad"],
    "retired sinks last even at highest days_running",
  );
});

test("rankByWinnerSignalAndIntent: same-tier ties break by winner_score, then days_running", () => {
  const mk = (hook: string, over: Partial<CompetitorAngle>): CompetitorAngle => ({
    advertiser: null,
    hook,
    framework: null,
    mechanismClaim: null,
    proof: null,
    offer: null,
    daysRunning: 30,
    heat: null,
    destinationDomain: null,
    imageUrl: null,
    resumeAdvertising: null,
    winnerTier: "proven",
    winnerScore: null,
    conceptTags: null,
    ...over,
  });
  const angles: CompetitorAngle[] = [
    mk("older weaker score", { winnerScore: 30, daysRunning: 80 }),
    mk("newer strongest score", { winnerScore: 50, daysRunning: 40 }),
    mk("same score newer days", { winnerScore: 50, daysRunning: 90 }),
  ];
  const ranked = rankByWinnerSignalAndIntent(angles);
  assert.deepEqual(
    ranked.map((a) => a.hook),
    ["same score newer days", "newer strongest score", "older weaker score"],
    "winner_score first, days_running second",
  );
});

// ── 3. intent — temperature-matching angles rank at the front, off-temp tails

test("rankByWinnerSignalAndIntent: cold intent surfaces unaware/problem_aware winners AHEAD of most_aware", () => {
  const mk = (hook: string, stage: ConceptTags["awareness_stage"], tier: string, score: number): CompetitorAngle => ({
    advertiser: null,
    hook,
    framework: null,
    mechanismClaim: null,
    proof: null,
    offer: null,
    daysRunning: 40,
    heat: null,
    destinationDomain: null,
    imageUrl: null,
    resumeAdvertising: null,
    winnerTier: tier,
    winnerScore: score,
    conceptTags: conceptTags({ awareness_stage: stage }),
  });
  const angles: CompetitorAngle[] = [
    // Highest tier + score is hot (most_aware) — WITHOUT intent it would lead.
    mk("hot most-aware winner", "most_aware", "proven", 90),
    mk("cold problem-aware winner", "problem_aware", "proven", 30),
    mk("cold unaware winner", "unaware", "building", 10),
    mk("warm product-aware winner", "product_aware", "proven", 60),
  ];
  const ranked = rankByWinnerSignalAndIntent(angles, {
    audience_temperature: "cold",
    purpose: "test-to-find-winner",
  });
  // Cold-matching angles (problem_aware, unaware) come first — internal order is winner-tier +
  // winner_score. Off-temp (most_aware, product_aware) fill the tail (still ranked by tier/score),
  // never dropped.
  assert.deepEqual(
    ranked.map((a) => a.hook),
    [
      "cold problem-aware winner", // proven, score 30 — but ON-TEMP
      "cold unaware winner", // building, score 10 — also on-temp
      "hot most-aware winner", // off-temp, tail leader by score
      "warm product-aware winner", // off-temp tail
    ],
  );
});

test("rankByWinnerSignalAndIntent: null awareness_stage is treated as off-temperature (tail, never dropped)", () => {
  const mk = (hook: string, tags: ConceptTags | null, tier: string, score: number): CompetitorAngle => ({
    advertiser: null,
    hook,
    framework: null,
    mechanismClaim: null,
    proof: null,
    offer: null,
    daysRunning: 40,
    heat: null,
    destinationDomain: null,
    imageUrl: null,
    resumeAdvertising: null,
    winnerTier: tier,
    winnerScore: score,
    conceptTags: tags,
  });
  const angles: CompetitorAngle[] = [
    mk("cold on-temp", conceptTags({ awareness_stage: "unaware" }), "proven", 30),
    mk("legacy no-tags row", null, "proven", 100),
  ];
  const ranked = rankByWinnerSignalAndIntent(angles, {
    audience_temperature: "cold",
    purpose: "test-to-find-winner",
  });
  assert.equal(ranked[0].hook, "cold on-temp");
  assert.equal(ranked[1].hook, "legacy no-tags row");
});

// ── 4. helpers — pin the mapping choices ────────────────────────────────────

test("awarenessStageMatchesTemperature: covers the whole Schwartz scale", () => {
  assert.equal(awarenessStageMatchesTemperature("unaware", "cold"), true);
  assert.equal(awarenessStageMatchesTemperature("problem_aware", "cold"), true);
  assert.equal(awarenessStageMatchesTemperature("solution_aware", "cold"), false);
  assert.equal(awarenessStageMatchesTemperature("solution_aware", "warm"), true);
  assert.equal(awarenessStageMatchesTemperature("product_aware", "warm"), true);
  assert.equal(awarenessStageMatchesTemperature("most_aware", "warm"), false);
  assert.equal(awarenessStageMatchesTemperature("most_aware", "hot"), true);
  assert.equal(awarenessStageMatchesTemperature(null, "cold"), false);
  assert.equal(awarenessStageMatchesTemperature(undefined, "cold"), false);
});

test("winnerTierRank: proven > building > new > retired; unknown treated as new", () => {
  assert.ok(winnerTierRank("proven") > winnerTierRank("building"));
  assert.ok(winnerTierRank("building") > winnerTierRank("new"));
  assert.ok(winnerTierRank("new") > winnerTierRank("retired"));
  assert.equal(winnerTierRank(null), winnerTierRank("new"));
  assert.equal(winnerTierRank(undefined), winnerTierRank("new"));
  assert.equal(winnerTierRank("random_future"), winnerTierRank("new"));
});

// ── 5. buildCreativeBrief surfaces conceptTags on the brief for competitor angles

test("buildCreativeBrief: surfaces conceptTags on the brief for a competitor angle threaded with the unified breakdown", async () => {
  const tags = conceptTags({
    angle: "energy without the crash",
    archetype: "us-vs-them",
    why_it_works: "positions the category villain as the crash + names the escape",
    cialdini_lever: "authority",
    awareness_stage: "problem_aware",
    format: "static_image",
  });
  const competitorAngle: ScoredAngle = {
    hook: "Ditch the 3pm crash",
    source: "competitor",
    leadBenefit: "sustained clean energy",
    acquisitionPower: 9,
    retentionTruth: 5,
    commodity: false,
    hasRealPhoto: false,
    reasons: ["proven competitor ad (65d)"],
    conceptTags: tags,
    raw: {
      advertiser: "MUD\\WTR",
      hook: "Ditch the 3pm crash — the mushroom coffee that actually works",
      framework: "hook-mech-offer",
      mechanismClaim: "adaptogens instead of caffeine spike",
      proof: "500K+ customers",
      offer: "30% off first order",
      imageUrl: "https://ex.com/img.jpg",
      conceptTags: tags,
    } as Record<string, unknown>,
  };

  // Minimal ProductIntelligence stub — buildCreativeBrief mostly needs product/media/store/offer
  // shapes + the reviews SDK.
  const pi: ProductIntelligence = {
    product: { title: "Superfood Coffee", handle: "coffee" } as Record<string, unknown>,
    reviews: { byClaim: async () => [] } as unknown as ProductIntelligence["reviews"],
    reviewAnalysis: null,
    adAngles: [],
    // selectAngles seeds the role='lead' benefit as a top hook candidate (dahlia-hooks-riff Phase 1);
    // an empty benefits array exercises the graceful-degrade path without crashing.
    benefits: [],
    ingredientResearch: [],
    store: { brandProofPoints: [] } as unknown as ProductIntelligence["store"],
    offer: null,
    media: { byCategory: {}, isolatedPackshots: [] } as unknown as ProductIntelligence["media"],
  } as unknown as ProductIntelligence;

  const brief = await buildCreativeBrief(pi, competitorAngle, []);
  assert.ok(brief.conceptTags, "brief carries conceptTags for competitor angle");
  assert.equal(brief.conceptTags?.angle, "energy without the crash");
  assert.equal(brief.conceptTags?.archetype, "us-vs-them");
  assert.equal(brief.conceptTags?.awareness_stage, "problem_aware");
});

test("buildCreativeBrief: leaves conceptTags null for an own-brand angle (never surfaces a fake winner-concept)", async () => {
  const ownAngle: ScoredAngle = {
    hook: "I lost 40 lbs",
    source: "transformation",
    leadBenefit: "real customer weight-loss story",
    acquisitionPower: 8,
    retentionTruth: 6,
    commodity: false,
    hasRealPhoto: false,
    reasons: [],
  };
  const pi: ProductIntelligence = {
    product: { title: "Superfood Coffee", handle: "coffee" } as Record<string, unknown>,
    reviews: { byClaim: async () => [] } as unknown as ProductIntelligence["reviews"],
    reviewAnalysis: null,
    adAngles: [],
    // selectAngles seeds the role='lead' benefit as a top hook candidate (dahlia-hooks-riff Phase 1);
    // an empty benefits array exercises the graceful-degrade path without crashing.
    benefits: [],
    ingredientResearch: [],
    store: { brandProofPoints: [] } as unknown as ProductIntelligence["store"],
    offer: null,
    media: { byCategory: {}, isolatedPackshots: [] } as unknown as ProductIntelligence["media"],
  } as unknown as ProductIntelligence;
  const brief = await buildCreativeBrief(pi, ownAngle, []);
  assert.equal(brief.conceptTags, null);
});

// ── competitor temperature FIT — focal-point selection (CEO 2026-07-17) ──────────────────────────
// Cold = curiosity / problem-solution ads (no offer); warm/hot = offer / mechanism / customer-review
// ads. An offer is the hard warm/hot tell — a cold audience should never imitate an offer/retargeting
// ad (closes the cold_offer_leak at its source instead of scrubbing the offer downstream).
function fitAngle(over: Partial<CompetitorAngle>): CompetitorAngle {
  return {
    advertiser: null, hook: null, framework: null, mechanismClaim: null, proof: null,
    offer: null, daysRunning: 40, heat: null, destinationDomain: null, imageUrl: null,
    resumeAdvertising: null, winnerTier: "proven", winnerScore: 50, conceptTags: null, ...over,
  };
}

test("competitorTemperatureFit: an OFFER ad is a MISMATCH for cold, a MATCH for warm/hot", () => {
  const offerAd = fitAngle({ offer: "50% OFF today" });
  assert.equal(competitorTemperatureFit(offerAd, "cold"), "mismatch");
  assert.equal(competitorTemperatureFit(offerAd, "warm"), "match");
  assert.equal(competitorTemperatureFit(offerAd, "hot"), "match");
});

test("competitorTemperatureFit: a curiosity / problem-solution ad (no offer) MATCHES cold", () => {
  const coldAd = fitAngle({ conceptTags: conceptTags({ awareness_stage: "problem_aware", cialdini_lever: null, archetype: "curiosity-hook" }) });
  assert.equal(competitorTemperatureFit(coldAd, "cold"), "match");
});

test("competitorTemperatureFit: a social-proof / review-focal ad (no offer, no cold stage) is a MISMATCH for cold", () => {
  const reviewAd = fitAngle({ conceptTags: conceptTags({ awareness_stage: "solution_aware", cialdini_lever: "social_proof", archetype: "social-proof-wall" }) });
  assert.equal(competitorTemperatureFit(reviewAd, "cold"), "mismatch");
  assert.equal(competitorTemperatureFit(reviewAd, "warm"), "match");
});

test("competitorTemperatureFit: a cold awareness stage WINS over a social-proof lever (offer is the only hard cold-disqualifier)", () => {
  const problemAwareWithProof = fitAngle({ conceptTags: conceptTags({ awareness_stage: "unaware", cialdini_lever: "social_proof" }) });
  assert.equal(competitorTemperatureFit(problemAwareWithProof, "cold"), "match");
});

test("rankByWinnerSignalAndIntent: for cold, an OFFER-bearing proven winner sinks BELOW an offer-less problem ad", () => {
  const angles: CompetitorAngle[] = [
    fitAngle({ hook: "offer winner", offer: "40% off", winnerTier: "proven", winnerScore: 100 }),
    fitAngle({ hook: "cold problem ad", offer: null, winnerTier: "building", winnerScore: 10, conceptTags: conceptTags({ awareness_stage: "problem_aware", cialdini_lever: null }) }),
  ];
  const ranked = rankByWinnerSignalAndIntent(angles, { audience_temperature: "cold", purpose: "test-to-find-winner" });
  assert.equal(ranked[0].hook, "cold problem ad", "the offer-less cold ad leads even though the offer ad is a higher-tier winner");
  assert.equal(ranked[1].hook, "offer winner");
});

test("getProvenCompetitorAngles: a VIDEO skeleton is EXCLUDED — Dahlia imitates static ads only", async () => {
  const { admin } = makeAdmin([
    skel({ hook: "static winner", media_type: "static", days_running: 50, concept_tags: conceptTags({}) }),
    skel({ hook: "processed video winner", media_type: "video", days_running: 90, concept_tags: conceptTags({}) }),
  ]);
  const { angles } = await getProvenCompetitorAngles(admin, WS, { productId: PRODUCT, limit: 10 });
  assert.deepEqual(angles.map((a) => a.hook), ["static winner"], "the video ad must not reach the imitation shelf");
});

// ── 6. competitorFocalIsWarmHot: authority + mechanism are COLD-appropriate (un-excluded 2026-07-19)

test("competitorFocalIsWarmHot: an authority-framed, offer-less winner is NOT warm/hot (cold-eligible)", () => {
  // The exact Guru Focus shape: every deeply-proven winner was cialdini='authority', awareness
  // 'solution_aware', no offer — which used to empty the cold shelf and force an own-brand fallback.
  const authorityWinner = { offer: null, conceptTags: { cialdini_lever: "authority", awareness_stage: "solution_aware", archetype: "expert-backed", angle: "10 weeks to younger skin" } };
  assert.equal(competitorFocalIsWarmHot(authorityWinner as never), false);
  // and it therefore reads cold-eligible (a match/neutral, never a mismatch) for a cold intent
  assert.notEqual(competitorTemperatureFit(authorityWinner as never, "cold"), "mismatch");
});

test("competitorFocalIsWarmHot: mechanism-focal (how-it-works) copy is NOT warm/hot", () => {
  const mechanism = { offer: null, conceptTags: { cialdini_lever: null, archetype: "mechanism", angle: "the mechanism that makes it work" } };
  assert.equal(competitorFocalIsWarmHot(mechanism as never), false);
});

test("competitorFocalIsWarmHot: the genuine warm/hot tells STILL exclude (offer / social_proof / scarcity / review)", () => {
  assert.equal(competitorFocalIsWarmHot({ offer: "30% off", conceptTags: { cialdini_lever: "authority" } } as never), true, "an offer is a hard warm/hot tell even with an authority lever");
  assert.equal(competitorFocalIsWarmHot({ offer: null, conceptTags: { cialdini_lever: "social_proof" } } as never), true);
  assert.equal(competitorFocalIsWarmHot({ offer: null, conceptTags: { cialdini_lever: "scarcity" } } as never), true);
  assert.equal(competitorFocalIsWarmHot({ offer: null, conceptTags: { cialdini_lever: null, archetype: "review", angle: "customer testimonial wall" } } as never), true);
});
