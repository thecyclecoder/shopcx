/**
 * Unit tests for the Growth Director Phase-3 experiment proposals + Slack digest
 * (growth-director-analytical-brief spec § Phase 3).
 *
 * Built-in node:test — no test-runner dependency. Run:
 *   npm run test:growth-director-experiment-proposals
 *   (= tsx --test src/lib/agents/growth-director-experiment-proposals.test.ts)
 *
 * The verification the SPEC asserts (baked into these tests):
 *   1. A flagged funnel hypothesis produces a proposed destination experiment
 *      at draft (NOT serving).
 *   2. A Max-authored brief in `#director-growth-max` names the hypothesis,
 *      evidence, and proposed test.
 *   3. The proposal is owner-gated.
 *   4. Grep confirms NO auto-serve / auto-spend path — the module never emits
 *      a status past `draft` and never carries a `serving` / `spending` verb
 *      in the ProposedExperiment payload. Asserted as a string-inspection over
 *      the produced object (mirroring what the spec's grep would find).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  composeGrowthDirectorDigest,
  proposeExperimentsFromHypotheses,
  proposalFromHypothesis,
  assertProposalOwnerGatedDraft,
  GROWTH_DIRECTOR_SLACK_CHANNEL,
  PROPOSAL_STATUS_DRAFT,
  PROPOSAL_CONFIDENCE_FLOOR,
  type ProposedExperiment,
} from "./growth-director-experiment-proposals";
import type { AnalyticalBriefResult } from "./growth-director-analytical-brief";
import type { Hypothesis, HypothesesResult } from "./growth-director-hypotheses";

// ── Fixture helpers ──────────────────────────────────────────────────────────

function mkHypothesis(over: Partial<Hypothesis> = {}): Hypothesis {
  return {
    kind: "funnel_not_creative",
    cohort: "tabs",
    cohort_label: "Tabs",
    meta_ad_id: "ad-tabs-cliff",
    title: "Tabs: LPV→ATC cliff (0.0% on 300 LPV)",
    summary: "Creative is doing its job (CTR 2.00% ≥ healthy 1.0%) but destination fails to carry clicks into carts — funnel/destination suspect.",
    evidence: [
      { field: "ctr", value: 2.0, threshold: 1.0 },
      { field: "landing_page_views", value: 300, threshold: 30 },
      { field: "add_to_carts", value: 0 },
      { field: "lpv_to_atc_rate", value: 0, threshold: 0.05 },
      { field: "lpv_to_atc_gap", value: 300 },
      { field: "spend_cents", value: 40_000, threshold: 5_000 },
    ],
    confidence: "high",
    ...over,
  };
}

function mkBrief(): AnalyticalBriefResult {
  return {
    workspaceId: "ws-1",
    windowStartIso: "2026-07-01T00:00:00Z",
    windowEndIso: "2026-07-08T23:59:59Z",
    cohorts: [
      {
        cohort: "tabs",
        cohort_label: "Tabs",
        creatives: 3,
        totals: {
          spend_cents: 60_000, impressions: 20_000, clicks: 400, ctr: 2.0,
          cpc_cents: 150, cpm_cents: 3000, frequency: 1.8, purchases: 0,
          revenue_cents: 0, roas: 0, cpa_cents: null,
          landing_page_views: 300, add_to_carts: 0, initiate_checkouts: 0,
        } as AnalyticalBriefResult["cohorts"][0]["totals"],
      },
    ],
    rows: [],
    unresolvedAdIds: [],
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test("funnel hypothesis → destination_experiment at status=draft (never running / auto-serve)", () => {
  const p = proposalFromHypothesis(mkHypothesis());
  assert.ok(p, "expected a proposal on a high-confidence funnel_not_creative hypothesis");
  assert.equal(p!.kind, "destination_experiment");
  assert.equal(p!.status, PROPOSAL_STATUS_DRAFT);
  assert.equal(p!.status, "draft"); // literal check — the spec's status assertion
  assert.equal(p!.owner_gated, true, "proposal must be owner-gated");
  assert.equal(p!.source_hypothesis_kind, "funnel_not_creative");
  assert.equal(p!.source_meta_ad_id, "ad-tabs-cliff");
  assert.ok(p!.destination, "destination payload required for destination_experiment");
  assert.equal(p!.destination!.lever, "matched_lander_destination");
  // The evidence must round-trip verbatim so the founder reads the SAME evidence in Slack.
  assert.equal(p!.evidence.length, 6);
  assert.deepEqual(
    p!.evidence.find((e) => e.field === "lpv_to_atc_rate"),
    { field: "lpv_to_atc_rate", value: 0, threshold: 0.05 },
  );
});

test("grep confirms no auto-serve / auto-spend / running path in the ProposedExperiment payload", () => {
  const p = proposalFromHypothesis(mkHypothesis())!;
  const serialized = JSON.stringify(p);
  for (const forbidden of ["auto_serve", "auto-serve", "auto_spend", "auto-spend", "\"running\"", "\"promoted\"", "start_spend"]) {
    assert.equal(serialized.includes(forbidden), false, `proposal must not contain "${forbidden}" — grep sanity`);
  }
});

test("medium-confidence hypothesis returns null — nothing routed, waits in the digest instead", () => {
  const p = proposalFromHypothesis(mkHypothesis({ confidence: "medium" }));
  assert.equal(p, null, "medium-confidence never routes a proposal");
});

test("format_effectiveness maps to a destination_experiment on the top variant's lander", () => {
  const p = proposalFromHypothesis(mkHypothesis({
    kind: "format_effectiveness",
    cohort: "amazing-coffee",
    cohort_label: "Amazing Coffee",
    meta_ad_id: undefined,
    title: "Amazing Coffee: advertorial wins vs beforeafter (ROAS 5.00 vs 1.50)",
    summary: "Within-cohort format signal — advertorial ROAS 5.00× on $200.00 vs beforeafter ROAS 1.50× on $200.00. Format matters.",
    evidence: [
      { field: "top_variant", value: "advertorial" },
      { field: "top_variant.roas", value: 5.0 },
      { field: "top_variant.spend_cents", value: 20_000, threshold: 5_000 },
      { field: "bottom_variant", value: "beforeafter" },
      { field: "bottom_variant.roas", value: 1.5 },
      { field: "format_roas_multiplier", value: 3.33, threshold: 1.5 },
    ],
  }));
  assert.ok(p);
  assert.equal(p!.kind, "destination_experiment");
  assert.equal(p!.destination?.lander_type, "advertorial");
  assert.equal(p!.destination?.lever, "matched_lander_format");
});

test("delivery_anomaly maps to creative_angle (refresh, not spend push)", () => {
  const p = proposalFromHypothesis(mkHypothesis({
    kind: "delivery_anomaly",
    cohort: "amazing-coffee",
    cohort_label: "Amazing Coffee",
    meta_ad_id: "ad-freq",
    title: "Amazing Coffee: audience fatigue on ad ad-freq",
    summary: "Delivery-side signal — frequency 5.50. Auction / audience saturation binding.",
    evidence: [{ field: "frequency", value: 5.5, threshold: 4.0 }],
  }));
  assert.ok(p);
  assert.equal(p!.kind, "creative_angle");
  assert.ok(p!.creative);
  assert.match(p!.proposed_test, /Author a fresh angle/);
});

test("audience_signal maps to audience_test (never a creative swap)", () => {
  const p = proposalFromHypothesis(mkHypothesis({
    kind: "audience_signal",
    cohort: "amazing-coffee",
    cohort_label: "Amazing Coffee",
    meta_ad_id: undefined,
    title: "Amazing Coffee: cohort-wide low CVR across 3 creatives (0.10% on 500 LPV)",
    summary: "Every qualifying ad delivers healthy CTR (mean 1.80%) but the cohort converts at 0.10%. Traffic is wrong-intent.",
    evidence: [
      { field: "qualifying_creatives", value: 3, threshold: 2 },
      { field: "cohort_cvr", value: 0.001, threshold: 0.01 },
    ],
  }));
  assert.ok(p);
  assert.equal(p!.kind, "audience_test");
  assert.ok(p!.audience);
});

test("proposeExperimentsFromHypotheses splits high (routed) vs medium (belowConfidenceFloor)", () => {
  const hi = mkHypothesis();
  const mid = mkHypothesis({ meta_ad_id: "ad-mid", confidence: "medium" });
  const result: HypothesesResult = {
    hypotheses: [hi, mid],
    belowFloor: [],
    gate: { min_spend_cents: 5000, min_impressions: 500, min_clicks: 20, min_landing_page_views: 30 },
  };
  const { proposals, belowConfidenceFloor } = proposeExperimentsFromHypotheses(result);
  assert.equal(proposals.length, 1);
  assert.equal(belowConfidenceFloor.length, 1);
  assert.equal(proposals[0].source_meta_ad_id, "ad-tabs-cliff");
  assert.equal(belowConfidenceFloor[0].meta_ad_id, "ad-mid");
});

test("composeGrowthDirectorDigest names hypothesis + evidence + proposed test in #director-growth-max", () => {
  const hyp = mkHypothesis();
  const result: HypothesesResult = {
    hypotheses: [hyp],
    belowFloor: [],
    gate: { min_spend_cents: 5000, min_impressions: 500, min_clicks: 20, min_landing_page_views: 30 },
  };
  const { proposals } = proposeExperimentsFromHypotheses(result);
  const digest = composeGrowthDirectorDigest(mkBrief(), result, proposals);

  assert.equal(digest.channel, "#director-growth-max");
  assert.equal(digest.channel, GROWTH_DIRECTOR_SLACK_CHANNEL);
  assert.equal(digest.quiet, false);

  // Flatten every block's text so the assertions read the whole digest.
  const asText = digest.blocks.flatMap((b) => {
    const parts: string[] = [];
    if (b.text) parts.push(b.text.text);
    if (b.elements) parts.push(...b.elements.map((e) => e.text));
    return parts;
  }).join("\n");

  // The verification's three assertions:
  assert.match(asText, /LPV→ATC cliff/, "digest must name the hypothesis title");
  assert.match(asText, /lpv_to_atc_rate=0/, "digest must cite the evidence verbatim");
  assert.match(asText, /matched-lander destination test/, "digest must name the proposed test");
  assert.match(asText, /status=draft/, "digest must announce the draft status");
  assert.match(asText, /owner-gated/, "digest must announce owner-gated");
  // NO auto-serve verb reaches the Slack text either.
  for (const forbidden of ["auto_serve", "auto-serve", "auto_spend", "auto-spend"]) {
    assert.equal(asText.toLowerCase().includes(forbidden), false);
  }
});

test("composeGrowthDirectorDigest quiet-week — nothing to say, still emits a well-formed digest", () => {
  const empty: HypothesesResult = {
    hypotheses: [],
    belowFloor: [],
    gate: { min_spend_cents: 5000, min_impressions: 500, min_clicks: 20, min_landing_page_views: 30 },
  };
  const digest = composeGrowthDirectorDigest(mkBrief(), empty, []);
  assert.equal(digest.quiet, true);
  assert.equal(digest.channel, GROWTH_DIRECTOR_SLACK_CHANNEL);
  assert.match(digest.text, /quiet week/i);
});

test("assertProposalOwnerGatedDraft is the WORKER's compare-and-set guard — refuses non-draft / non-owner-gated", () => {
  const good = proposalFromHypothesis(mkHypothesis())!;
  assert.doesNotThrow(() => assertProposalOwnerGatedDraft(good));

  const bad1 = { ...good, status: "running" as unknown as typeof PROPOSAL_STATUS_DRAFT };
  assert.throws(() => assertProposalOwnerGatedDraft(bad1 as ProposedExperiment), /refusing non-draft/);

  const bad2 = { ...good, owner_gated: false as unknown as true };
  assert.throws(() => assertProposalOwnerGatedDraft(bad2 as ProposedExperiment), /refusing non-owner-gated/);
});

test("exports the confidence floor + draft status constants so callers cite the exact rail", () => {
  assert.equal(PROPOSAL_CONFIDENCE_FLOOR, "high");
  assert.equal(PROPOSAL_STATUS_DRAFT, "draft");
  assert.equal(GROWTH_DIRECTOR_SLACK_CHANNEL, "#director-growth-max");
});
