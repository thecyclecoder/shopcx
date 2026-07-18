/**
 * Unit tests for buildFirewallReviseReason
 * (dahlia-recovers-from-firewall-claim-miss-actionable-revise-reason-not-exhaust Phase 1).
 *
 * Pins the invariants that make a firewall claim-miss RECOVERABLE for Dahlia — she gets back
 * a reason that names the exact miss AND surfaces the product's real available grounded
 * benefits AND steers her to DROP the ungrounded claim and LEAD with a listed real benefit,
 * instead of the old terse `firewall_claim_miss: <source>:<reason>` that let her rewrite
 * another ungrounded competitor-flavored claim on every attempt.
 *
 * Run:
 *   npm run test:creative-agent-firewall-recovery
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { CreativeBrief } from "@/lib/ads/creative-brief";
import type { ClaimMiss } from "@/lib/ads/never-fabricate";
import { buildFirewallReviseReason, COPY_AUTHOR_REVISE_REASON_MAX_LEN } from "./creative-agent";

function brief(
  overrides: Partial<Pick<CreativeBrief, "leadProof" | "supportingBenefits" | "proofStack" | "competitorDna">> = {},
): Pick<CreativeBrief, "leadProof" | "supportingBenefits" | "proofStack" | "competitorDna"> {
  return {
    leadProof: null,
    supportingBenefits: [],
    proofStack: [],
    ...overrides,
  };
}

test("leadProof:claim_not_in_source names the missed claim + surfaces the real benefits + steers to DROP/LEAD", () => {
  // The exact failure mode the CEO cited: Superfood Tabs free-tote COMPETITOR angle blew out
  // on `firewall_claim_miss: leadProof:claim_not_in_source` while `supportingBenefits` sitting
  // in the brief were the real grounded ones ('reduce bloating', 'support metabolism',
  // 'curb cravings'). The reason MUST name the claim + surface those benefits + steer.
  const miss: ClaimMiss = {
    claim: "clinically proven to shed 10 pounds in 7 days",
    source: "leadProof",
    source_ref: "leadProof",
    reason: "claim_not_in_source",
  };
  const b = brief({
    supportingBenefits: ["reduce bloating", "support metabolism", "curb cravings"],
  });

  const reason = buildFirewallReviseReason([miss], b);

  // (a) The missed claim is quoted back at her (clipped is fine — the substring survives).
  assert.ok(reason.includes("clinically proven to shed 10 pounds"), `missing claim substring: ${reason}`);
  // (b) The exact source + reason token — a `parseAuthorVerdict`-style breadcrumb.
  assert.ok(reason.includes("leadProof:claim_not_in_source"), `missing source:reason token: ${reason}`);
  // (c) EVERY real grounded benefit from the brief is surfaced.
  assert.ok(reason.includes("reduce bloating"), `missing 'reduce bloating': ${reason}`);
  assert.ok(reason.includes("support metabolism"), `missing 'support metabolism': ${reason}`);
  assert.ok(reason.includes("curb cravings"), `missing 'curb cravings': ${reason}`);
  // (d) The concrete steer — the word DROP + LEAD must both appear so Dahlia knows the action.
  assert.ok(/drop/i.test(reason), `steer missing DROP verb: ${reason}`);
  assert.ok(/lead/i.test(reason), `steer missing LEAD verb: ${reason}`);
  // (e) Length cap respected.
  assert.ok(reason.length <= COPY_AUTHOR_REVISE_REASON_MAX_LEN, `reason overflows cap: ${reason.length}`);
});

test("leadProof text + proofStack are ALSO surfaced as available grounded benefits", () => {
  const miss: ClaimMiss = {
    claim: "burn 500 calories a day",
    source: "leadProof",
    source_ref: "leadProof",
    reason: "fabricated_number",
  };
  const b = brief({
    leadProof: { kind: "review", text: "I feel focused all day", attribution: "Sarah M." },
    supportingBenefits: ["steady focus"],
    proofStack: ["Non-GMO", "30-day money-back guarantee"],
  });

  const reason = buildFirewallReviseReason([miss], b);
  assert.ok(reason.includes("I feel focused all day"), `leadProof text not surfaced: ${reason}`);
  assert.ok(reason.includes("steady focus"), `supportingBenefit not surfaced: ${reason}`);
  assert.ok(reason.includes("Non-GMO"), `proofStack not surfaced: ${reason}`);
  assert.ok(reason.includes("30-day money-back guarantee"), `proofStack not surfaced: ${reason}`);
});

test("competitor angle steer keeps the winner's structure but grounds in OUR benefit, not their offer", () => {
  const miss: ClaimMiss = {
    claim: "get a free tote with every order",
    source: "competitorDna",
    source_ref: "offer",
    reason: "claim_not_in_source",
  };
  const b = brief({
    supportingBenefits: ["reduce bloating", "support metabolism", "curb cravings"],
    competitorDna: {
      hook: "The tea that flattens your stomach",
      framework: null,
      mechanismClaim: null,
      proof: null,
      offer: "free tote with every order",
      competitorAdvertiser: "TeaCo",
    },
  });

  const reason = buildFirewallReviseReason([miss], b);
  // Competitor variant — steer references OUR benefit vs their offer.
  assert.ok(/our.*benefit/i.test(reason), `competitor steer missing 'OUR benefit' anchor: ${reason}`);
  assert.ok(/not their offer/i.test(reason), `competitor steer missing 'not their offer' anchor: ${reason}`);
  assert.ok(/drop/i.test(reason), `competitor steer missing DROP verb: ${reason}`);
  assert.ok(/lead/i.test(reason), `competitor steer missing LEAD verb: ${reason}`);
  assert.ok(reason.includes("reduce bloating"), `benefits not surfaced on competitor angle: ${reason}`);
});

test("non-competitor angle uses the default steer (no 'not their offer' text)", () => {
  const miss: ClaimMiss = {
    claim: "makes you smarter",
    source: "supportingBenefit",
    source_ref: "cognitive",
    reason: "claim_not_in_source",
  };
  const b = brief({
    supportingBenefits: ["steady focus"],
  });
  const reason = buildFirewallReviseReason([miss], b);
  assert.equal(/not their offer/i.test(reason), false, `default steer should not mention 'their offer': ${reason}`);
  assert.ok(/drop/i.test(reason));
  assert.ok(/lead/i.test(reason));
});

test("respects COPY_AUTHOR_REVISE_REASON_MAX_LEN — truncates the benefit list, keeps the steer intact", () => {
  const miss: ClaimMiss = {
    claim: "cures every disease known to humankind",
    source: "leadProof",
    source_ref: "leadProof",
    reason: "claim_not_in_source",
  };
  // Give it a firehose of supporting benefits that would push far past the cap.
  const benefits = Array.from({ length: 50 }, (_, i) => `benefit number ${i} with a decent description`);
  const b = brief({ supportingBenefits: benefits });

  const reason = buildFirewallReviseReason([miss], b);
  assert.ok(reason.length <= COPY_AUTHOR_REVISE_REASON_MAX_LEN, `reason overflows cap: ${reason.length}`);
  // Steer stays intact per the spec — DROP + LEAD verbs survive.
  assert.ok(/drop/i.test(reason), `steer DROP lost after truncation: ${reason}`);
  assert.ok(/lead/i.test(reason), `steer LEAD lost after truncation: ${reason}`);
  // Miss identity survives too (per-miss token is a small fixed head).
  assert.ok(reason.includes("leadProof:claim_not_in_source"), `miss identity lost after truncation: ${reason}`);
});

test("dedupes benefits case-insensitively — no repeated 'reduce bloating'", () => {
  const miss: ClaimMiss = {
    claim: "x",
    source: "leadProof",
    source_ref: "leadProof",
    reason: "source_not_found",
  };
  const b = brief({
    leadProof: { kind: "review", text: "reduce bloating", attribution: "A" },
    supportingBenefits: ["Reduce Bloating", "reduce bloating", "support metabolism"],
  });
  const reason = buildFirewallReviseReason([miss], b);
  const occurrences = reason.toLowerCase().split("reduce bloating").length - 1;
  assert.equal(occurrences, 1, `expected 'reduce bloating' once, got ${occurrences} in: ${reason}`);
  assert.ok(reason.includes("support metabolism"));
});

test("multiple misses are ALL enumerated in the head", () => {
  const misses: ClaimMiss[] = [
    { claim: "claim one", source: "leadProof", source_ref: "leadProof", reason: "claim_not_in_source" },
    { claim: "claim two", source: "supportingBenefit", source_ref: "bogus", reason: "source_not_found" },
  ];
  const b = brief({ supportingBenefits: ["steady focus"] });
  const reason = buildFirewallReviseReason(misses, b);
  assert.ok(reason.includes("leadProof:claim_not_in_source"), `first miss missing: ${reason}`);
  assert.ok(reason.includes("supportingBenefit:source_not_found"), `second miss missing: ${reason}`);
});

test("empty misses array still produces a valid, capped reason (defensive)", () => {
  const b = brief({ supportingBenefits: ["steady focus"] });
  const reason = buildFirewallReviseReason([], b);
  assert.ok(reason.startsWith("firewall_claim_miss:"), `head lost: ${reason}`);
  assert.ok(reason.length <= COPY_AUTHOR_REVISE_REASON_MAX_LEN);
});

test("no available benefits in the brief — reason still ships with the steer + head", () => {
  const miss: ClaimMiss = {
    claim: "invented benefit",
    source: "leadProof",
    source_ref: "leadProof",
    reason: "source_not_found",
  };
  const reason = buildFirewallReviseReason([miss], brief());
  assert.ok(reason.includes("leadProof:source_not_found"));
  assert.ok(/drop/i.test(reason));
  assert.ok(/lead/i.test(reason));
  assert.ok(reason.length <= COPY_AUTHOR_REVISE_REASON_MAX_LEN);
});
