/**
 * Unit tests for the crown/kill decision-tree bands (CEO Dylan 2026-07-12) as applied by
 * classifyAd — see docs/brain/reference/meta-scaling-methodology.md. Pure function, no DB.
 *
 * Run: npx tsx --test src/lib/ads/ad-insights-sdk.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { classifyAd, MIN_PURCHASES, DECISION_DEADLINE_SPEND, VERDICT_FLOOR_SPEND, type AdInsight, type CacThresholds } from "./ad-insights-sdk";

// Live setpoints: crown/target CAC $150, kill/profit-floor CAC $220.
const T: CacThresholds = { ltv: 330, targetCac: 150, killCac: 220, basis: "test" };

function ad(spend: number, purchases: number, extra: Partial<AdInsight> = {}): AdInsight {
  return {
    adId: "a", name: "n", campaign: "c", adSet: "s", adSetId: "s1", spend, impressions: 10000, frequency: 1.5,
    linkClicks: 100, linkCtr: 1.5, cpc: 1, cpm: 20, landingPageViews: 80, addToCart: 5,
    initiateCheckout: 3, purchases, revenue: purchases * 100, destination: "shopify_pdp",
    conversionSource: "meta", ...extra,
  };
}

test("below the $450 verdict floor → still testing", () => {
  assert.equal(classifyAd(ad(300, 2), T).verdict, "below_floor");
});

test("crown NEEDS >=8 purchases — a 3-purchase converter at target CPA is HOLD, not a winner", () => {
  // $450 / 3 = $150 CPA (<= $150) but only 3 purchases → the ingredient-breakdown case.
  const v = classifyAd(ad(450, 3), T);
  assert.equal(v.verdict, "hold");
  assert.ok(v.action.includes(`/${MIN_PURCHASES}`));
});

test("crowns once CPA <= target AND >=8 purchases", () => {
  assert.equal(classifyAd(ad(1050, 8), T).verdict, "winner"); // $131 CPA, 8 purchases
});

test("$640 / $160 CPA (~4 purchases) → HOLD, not killed (the founder's question)", () => {
  assert.equal(classifyAd(ad(640, 4), T).verdict, "hold"); // 640/4 = $160
});

test("slow-kill: converting but unprofitable (CPA > $220 profit floor)", () => {
  assert.equal(classifyAd(ad(600, 2), T).verdict, "kill"); // $300 CPA
});

test("dud: 0 purchases past the floor → kill", () => {
  assert.equal(classifyAd(ad(500, 0), T).verdict, "kill");
});

test("decision deadline: at $1,200 without crowning → retire even if profitable", () => {
  const v = classifyAd(ad(DECISION_DEADLINE_SPEND, 7), T); // $171 CPA, never crowned
  assert.equal(v.verdict, "kill");
  assert.ok(v.action.includes("deadline"));
});

test("a crown-qualified ad at the deadline is NOT retired — it wins", () => {
  assert.equal(classifyAd(ad(DECISION_DEADLINE_SPEND, 9), T).verdict, "winner"); // $133 CPA, 9 purchases
});

test("setpoints: crown floor 8, verdict floor $450, deadline $1,200", () => {
  assert.equal(MIN_PURCHASES, 8);
  assert.equal(VERDICT_FLOOR_SPEND, 450);
  assert.equal(DECISION_DEADLINE_SPEND, 1200);
});
