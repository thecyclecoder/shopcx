import { test } from "node:test";
import assert from "node:assert/strict";
import { angleKey } from "@/lib/ads/creative-learning";
import { deriveExecutionPath, deriveExploreExploit } from "@/lib/ads/ads-read-sdk";
import type { AngleProvenance, AuthorSelfScore } from "@/lib/ads/creative-agent";

const selfScore: AuthorSelfScore = { lf8: 8, schwartz: 8, cialdini: 8, hopkins: 8, sugarman: 8, total: 40, evidence: [] };

function prov(mode: "explore" | "exploit", source: AngleProvenance["source"], lead: string): AngleProvenance {
  return { mode, source, competitor_advertiser: null, competitor_ad_image_url: null, competitor_hook: null, lead_benefit: lead };
}

test("deriveExecutionPath: null self-score ⇒ deterministic node path", () => {
  assert.equal(deriveExecutionPath(null), "deterministic-node");
});

test("deriveExecutionPath: any self-score object ⇒ author box session", () => {
  assert.equal(deriveExecutionPath(selfScore), "author-box-session");
});

test("competitor angle with no crown ⇒ explore badge, explore truth, not mislabeled", () => {
  const angle = { source: "competitor" as const, provenance: prov("explore", "competitor", "sharper focus"), hookOneLiner: null, metaHeadline: null, leadBenefitAnchor: "sharper focus" };
  const v = deriveExploreExploit(angle, new Set());
  assert.equal(v.badgeMode, "explore");
  assert.equal(v.trueIntent, "explore");
  assert.equal(v.mislabeledExploit, false);
});

test("own-brand angle with NO crown ⇒ EXPLOIT badge but EXPLORE truth = mislabeledExploit (the 115f51bc defect)", () => {
  const angle = { source: "benefit" as const, provenance: prov("exploit", "benefit", "calm steady energy no jitters no crash"), hookOneLiner: null, metaHeadline: null, leadBenefitAnchor: "calm steady energy no jitters no crash" };
  const v = deriveExploreExploit(angle, new Set());
  assert.equal(v.badgeMode, "exploit");
  assert.equal(v.trueIntent, "explore", "no crowned winner ⇒ it is really an explore");
  assert.equal(v.hasCrownForConcept, false);
  assert.equal(v.mislabeledExploit, true);
});

test("own-brand angle WITH a crown for its concept ⇒ EXPLOIT badge AND EXPLOIT truth = legit, not mislabeled", () => {
  const lead = "calm steady energy no jitters no crash";
  const angle = { source: "benefit" as const, provenance: prov("exploit", "benefit", lead), hookOneLiner: null, metaHeadline: null, leadBenefitAnchor: lead };
  const crowned = new Set([angleKey(lead)]);
  const v = deriveExploreExploit(angle, crowned);
  assert.equal(v.badgeMode, "exploit");
  assert.equal(v.hasCrownForConcept, true);
  assert.equal(v.trueIntent, "exploit");
  assert.equal(v.mislabeledExploit, false);
});

test("null angle ⇒ no badge, explore truth", () => {
  const v = deriveExploreExploit(null, new Set());
  assert.equal(v.badgeMode, null);
  assert.equal(v.trueIntent, "explore");
  assert.equal(v.mislabeledExploit, false);
});
