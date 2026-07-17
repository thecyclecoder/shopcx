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
  concept_tags: ConceptTags | null;
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
    concept_tags: null,
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
    ingredientResearch: [],
    store: { brandProofPoints: [] } as unknown as ProductIntelligence["store"],
    offer: null,
    media: { byCategory: {}, isolatedPackshots: [] } as unknown as ProductIntelligence["media"],
  } as unknown as ProductIntelligence;
  const brief = await buildCreativeBrief(pi, ownAngle, []);
  assert.equal(brief.conceptTags, null);
});
