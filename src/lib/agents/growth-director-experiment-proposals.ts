/**
 * Growth Director experiment proposals + Slack digest — Phase 3
 * (growth-director-analytical-brief spec).
 *
 * Takes the Phase-2 [[./growth-director-hypotheses]] result and turns each
 * HIGH-confidence hypothesis into a PROPOSED experiment via one of the three
 * existing acquisition-hub routes:
 *
 *   - `destination_experiment` ← funnel-not-creative OR format-effectiveness
 *     → a [[../libraries/storefront-experiments]] matched-lander / destination test.
 *   - `creative_angle`         ← delivery-anomaly (CPM/frequency fatigue)
 *     → the creative maker / ideas bin — a fresh angle to refresh the audience.
 *   - `audience_test`          ← audience-signal
 *     → a new test ad set with a narrower interest / audience thesis.
 *
 * ── North star (spec + [[../operational-rules]] § supervisable autonomy) ──
 * Max PROPOSES and ROUTES; he never serves spend on his own. Every
 * ProposedExperiment has:
 *   - `status: 'draft'` — never `'running'` / `'promoted'` — the same draft rail
 *     acquisition-hub gates on. No code path in this module flips a proposal's
 *     status past draft — the verification's third check (grep confirms).
 *   - `owner_gated: true` — an explicit typed constant on every proposal so a
 *     downstream router that mishandles it fails loudly, not silently.
 *
 * ── The Slack digest (#director-growth-max) ──────────────────────────────────
 * `composeGrowthDirectorDigest` returns a fully-formed Slack blocks-kit message
 * (channel + text fallback + blocks) that the worker posts on cadence via the
 * standard `postMessage` slack path (see [[../slack]]). The digest names EVERY
 * hypothesis's title / evidence / confidence + the linked proposed test, so the
 * founder reads the WHY next to the WHAT.
 *
 * MEDIUM-confidence hypotheses NEVER produce a proposal (they'd land in the
 * `low_confidence` section of the digest so the founder can see the read
 * without a test being routed against a shaky signal). The spec's confidence
 * gate is symmetric to the media-buyer's verdict floor discipline —
 * high-confidence-only routing is the same "no rubber-stamps" rail.
 *
 * See [[../libraries/growth-director-experiment-proposals]] · spec
 * `docs/brain/specs/growth-director-analytical-brief.md` § Phase 3.
 */
import type { AnalyticalBriefResult } from "./growth-director-analytical-brief";
import type {
  Hypothesis,
  HypothesisConfidence,
  HypothesisEvidence,
  HypothesesResult,
} from "./growth-director-hypotheses";

// ── North-star constants ─────────────────────────────────────────────────────

/**
 * The Slack channel the digest routes into. Kept as a NAMED constant so an
 * audit of "where does the Growth Director talk to the founder" resolves via
 * grep, never a raw string.
 */
export const GROWTH_DIRECTOR_SLACK_CHANNEL = "#director-growth-max" as const;

/**
 * The ONLY status a Phase-3 proposal ever carries. Any downstream that reads
 * `PROPOSAL_STATUS_DRAFT` and sees anything else has been mutated after we
 * emitted — the router refuses. Matches [[../storefront/experiments]]
 * `ExperimentStatus = 'draft'` verbatim.
 */
export const PROPOSAL_STATUS_DRAFT = "draft" as const;
export type ProposalStatus = typeof PROPOSAL_STATUS_DRAFT;

/**
 * Only `high` confidence hypotheses turn into ROUTED proposals — a `medium`
 * hypothesis lands in the digest's low-confidence section so the founder sees
 * the read, but nothing gets routed against a shaky signal. Symmetric to
 * media-buyer $50-floor discipline.
 */
export const PROPOSAL_CONFIDENCE_FLOOR: HypothesisConfidence = "high";

// ── Proposal shapes ──────────────────────────────────────────────────────────

export type ProposalKind = "destination_experiment" | "creative_angle" | "audience_test";

/** Payload for a destination_experiment — a matched-lander / destination test. */
export interface DestinationExperimentPayload {
  /** the winning variant/lander_type the test SWAPS TO (e.g. 'advertorial'). */
  lander_type: "advertorial" | "beforeafter" | "listicle" | "pdp";
  /** the storefront-experiments lever the caller writes on insert
   *  ([[../storefront/experiments]] `lever`). Kept as text so future levers don't
   *  need this file bumped. */
  lever: string;
  /** the audience string the caller writes on insert (default matches the
   *  storefront-experiment default `'all'`). */
  audience: string;
}

/** Payload for a creative_angle — routed into the creative maker / ideas bin. */
export interface CreativeAnglePayload {
  /** what the new angle should hook on — free-form for the maker to consume. */
  hook_thesis: string;
}

/** Payload for an audience_test — a new test ad set with a narrower thesis. */
export interface AudienceTestPayload {
  /** what the audience thesis is (interests, lookalike, exclusions). */
  audience_summary: string;
}

/** One piece of cited evidence echoed from the source hypothesis — the founder-reads-verbatim promise. */
export interface ProposedExperimentEvidence extends HypothesisEvidence {
  /** Passed through unchanged so a downstream diff is a `deepEqual`. */
}

/** A PROPOSED experiment. Never running; never spending. Owner-gated. */
export interface ProposedExperiment {
  kind: ProposalKind;
  /** product handle (matches [[./growth-director-analytical-brief]] cohort). */
  cohort: string;
  cohort_label: string;
  /** ALWAYS `PROPOSAL_STATUS_DRAFT`. Type-narrowed so a caller can't pass 'running' here. */
  status: ProposalStatus;
  /** ALWAYS `true`. A router that sees anything else — even undefined — must refuse to serve. */
  owner_gated: true;
  /** the hypothesis kind that spawned this proposal — the audit chain the founder reads. */
  source_hypothesis_kind: Hypothesis["kind"];
  /** null for cohort-level proposals; the Meta ad id for per-creative proposals. */
  source_meta_ad_id: string | null;
  /** Short human title, e.g. `Tabs: matched-lander destination test (advertorial)`. */
  title: string;
  /** One-liner why this test is the right response to the hypothesis. */
  summary: string;
  /** One-liner what the test would DO — "swap destination to advertorial", "author a fresh hook…". */
  proposed_test: string;
  /** Payload — exactly one of these three is populated (the one matching `kind`). */
  destination?: DestinationExperimentPayload;
  creative?: CreativeAnglePayload;
  audience?: AudienceTestPayload;
  /** Echoed evidence from the source hypothesis — the founder-reads-verbatim promise. */
  evidence: ProposedExperimentEvidence[];
}

// ── The mapper ───────────────────────────────────────────────────────────────

/** Map one hypothesis to one proposal. Returns `null` when the hypothesis is
 *  below the confidence floor (medium — landed in the digest, not routed) or
 *  when the hypothesis kind has no routing verb (defensive — every current
 *  kind maps, but this keeps the switch total-safe). */
export function proposalFromHypothesis(h: Hypothesis): ProposedExperiment | null {
  if (h.confidence !== PROPOSAL_CONFIDENCE_FLOOR) return null;

  const base = {
    cohort: h.cohort,
    cohort_label: h.cohort_label,
    status: PROPOSAL_STATUS_DRAFT,
    owner_gated: true as const,
    source_hypothesis_kind: h.kind,
    source_meta_ad_id: h.meta_ad_id ?? null,
    evidence: h.evidence.map((e) => ({ field: e.field, value: e.value, threshold: e.threshold })),
  };

  switch (h.kind) {
    case "funnel_not_creative": {
      // A high-CTR / zero-ATC case: propose a MATCHED-LANDER destination test — swap the
      // creative's destination to the (advertorial) lander that historically converts on this cohort.
      return {
        ...base,
        kind: "destination_experiment",
        title: `${h.cohort_label}: matched-lander destination test`,
        summary: `Ad delivers CTR / LPV but the destination isn't converting — swap the destination to the historically-converting lander for ${h.cohort_label}.`,
        proposed_test: `Route ad ${h.meta_ad_id ?? "(all)"} to the ${h.cohort_label} advertorial lander; hold the current destination as control.`,
        destination: { lander_type: "advertorial", lever: "matched_lander_destination", audience: "all" },
      };
    }
    case "format_effectiveness": {
      // Top variant beats the bottom by ≥1.5× — matched-lander test on the winning format.
      const topVar = evidenceValue(h, "top_variant");
      const landerType = normalizeLanderType(topVar);
      return {
        ...base,
        kind: "destination_experiment",
        title: `${h.cohort_label}: matched-lander destination test (${topVar ?? landerType})`,
        summary: `Within-cohort format signal — the top-ROAS variant carries the traffic ${h.cohort_label} arrives with. Propose a matched-lander test on that format.`,
        proposed_test: `Serve the ${topVar ?? landerType} lander to ${h.cohort_label} traffic; hold the lower-ROAS variant as control.`,
        destination: { lander_type: landerType, lever: "matched_lander_format", audience: "all" },
      };
    }
    case "delivery_anomaly": {
      // CPM spike / fatigue frequency — refresh the angle.
      return {
        ...base,
        kind: "creative_angle",
        title: `${h.cohort_label}: refresh angle (audience fatigue / CPM spike)`,
        summary: `Delivery-side signal on ad ${h.meta_ad_id ?? "(cohort)"} — audience/auction is the binding constraint. Route to the creative maker for a fresh angle rather than another spend push.`,
        proposed_test: `Author a fresh angle in the ideas bin for ${h.cohort_label}, targeting a lower-frequency lookalike; hold the current angle live.`,
        creative: { hook_thesis: `Fresh angle for ${h.cohort_label} — target a fresher audience without spending more on the saturated one.` },
      };
    }
    case "audience_signal": {
      // Cohort-wide low CVR at healthy CTR — audience test with a narrower thesis.
      return {
        ...base,
        kind: "audience_test",
        title: `${h.cohort_label}: audience narrowing test`,
        summary: `Traffic arrives (CTR healthy) but no one buys — narrow the audience thesis rather than iterate creatives.`,
        proposed_test: `Draft a new ${h.cohort_label} test ad set with a narrower interest thesis; hold the current audience as control.`,
        audience: { audience_summary: `Narrower interest / lookalike thesis for ${h.cohort_label} — narrower than the current audience.` },
      };
    }
  }
}

/** Pull a scalar value from a hypothesis's evidence array by field name. */
function evidenceValue(h: Hypothesis, field: string): string | number | undefined {
  const e = h.evidence.find((r) => r.field === field);
  return e?.value;
}

/** Normalize a `top_variant` value to a `lander_type` supported by [[../storefront/experiments]]. */
function normalizeLanderType(top: string | number | undefined): "advertorial" | "beforeafter" | "listicle" | "pdp" {
  const s = typeof top === "string" ? top.toLowerCase() : "";
  if (s === "advertorial") return "advertorial";
  if (s === "beforeafter") return "beforeafter";
  if (s === "reasons" || s === "listicle") return "listicle";
  return "advertorial"; // safe default — the highest-conversion default in the app
}

/**
 * Map every high-confidence hypothesis to a proposal. Medium-confidence returns
 * as `belowConfidenceFloor` so the digest can narrate them without routing.
 */
export function proposeExperimentsFromHypotheses(
  hypotheses: HypothesesResult,
): { proposals: ProposedExperiment[]; belowConfidenceFloor: Hypothesis[] } {
  const proposals: ProposedExperiment[] = [];
  const belowConfidenceFloor: Hypothesis[] = [];
  for (const h of hypotheses.hypotheses) {
    if (h.confidence !== PROPOSAL_CONFIDENCE_FLOOR) {
      belowConfidenceFloor.push(h);
      continue;
    }
    const p = proposalFromHypothesis(h);
    if (p) proposals.push(p);
  }
  return { proposals, belowConfidenceFloor };
}

// ── The Slack digest ─────────────────────────────────────────────────────────

/** One Slack blocks-kit block — kept minimal + typed so this module compiles free
 *  of a Slack SDK dependency (the caller passes it through to `postMessage`). */
export interface DigestBlock {
  type: "section" | "divider" | "header" | "context";
  text?: { type: "mrkdwn" | "plain_text"; text: string };
  elements?: Array<{ type: "mrkdwn" | "plain_text"; text: string }>;
}

/** The composed digest — channel + fallback text + blocks. Caller posts via `postMessage`. */
export interface GrowthDirectorDigest {
  channel: typeof GROWTH_DIRECTOR_SLACK_CHANNEL;
  text: string;
  blocks: DigestBlock[];
  /** true when NEITHER hypotheses nor proposals surfaced — a quiet-week digest. */
  quiet: boolean;
}

/**
 * Compose the analytical brief + hypotheses + proposals into a Slack digest for
 * `#director-growth-max`. Every hypothesis's title / evidence / confidence is
 * named + the linked proposed test is called out — the verification that the
 * digest "names the hypothesis, evidence, and proposed test."
 */
export function composeGrowthDirectorDigest(
  brief: AnalyticalBriefResult,
  hypotheses: HypothesesResult,
  proposals: ProposedExperiment[],
): GrowthDirectorDigest {
  const window = `${brief.windowStartIso.slice(0, 10)} → ${brief.windowEndIso.slice(0, 10)}`;
  const cohortLine = brief.cohorts.length
    ? brief.cohorts.map((c) => `${c.cohort_label} ($${(c.totals.spend_cents / 100).toFixed(0)} / ${c.creatives} creatives)`).join(" · ")
    : "no live cohorts";

  const blocks: DigestBlock[] = [
    { type: "header", text: { type: "plain_text", text: `Growth Director brief — ${window}` } },
    { type: "section", text: { type: "mrkdwn", text: `*Cohorts:* ${cohortLine}` } },
  ];

  if (hypotheses.hypotheses.length === 0 && proposals.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_Quiet week — no hypothesis cleared the sample gate. No proposals routed._" },
    });
    return {
      channel: GROWTH_DIRECTOR_SLACK_CHANNEL,
      text: `Growth Director brief — ${window}: quiet week`,
      blocks,
      quiet: true,
    };
  }

  // Hypotheses section — every hypothesis rendered, with confidence + evidence lines.
  blocks.push({ type: "divider" });
  blocks.push({ type: "header", text: { type: "plain_text", text: `Hypotheses (${hypotheses.hypotheses.length})` } });
  for (const h of hypotheses.hypotheses) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*${h.title}* _(${h.confidence} confidence)_`,
          h.summary,
          `_Evidence:_ ${renderEvidence(h.evidence)}`,
        ].join("\n"),
      },
    });
  }

  // Proposals section — every proposal rendered, with its owner-gated / draft status
  // and the source hypothesis kind called out so the founder can trace the audit.
  blocks.push({ type: "divider" });
  blocks.push({
    type: "header",
    text: { type: "plain_text", text: `Proposed experiments (${proposals.length}) — draft, owner-gated` },
  });
  if (proposals.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_No high-confidence hypothesis cleared the routing floor — nothing to serve, nothing to approve._" },
    });
  } else {
    for (const p of proposals) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            `*${p.title}* _(${p.kind} · status=${p.status} · owner-gated)_`,
            `_Source hypothesis:_ ${p.source_hypothesis_kind}${p.source_meta_ad_id ? ` (ad ${p.source_meta_ad_id})` : ""}`,
            `_Proposed test:_ ${p.proposed_test}`,
            `_Rationale:_ ${p.summary}`,
          ].join("\n"),
        },
      });
    }
  }

  if (hypotheses.belowFloor.length) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "context",
      elements: [
        { type: "mrkdwn", text: `${hypotheses.belowFloor.length} creative(s)/cohort(s) below the sample gate — no call.` },
      ],
    });
  }

  const text = [
    `Growth Director brief — ${window}`,
    `${hypotheses.hypotheses.length} hypothesis/es · ${proposals.length} draft proposal(s), owner-gated`,
  ].join(" · ");

  return { channel: GROWTH_DIRECTOR_SLACK_CHANNEL, text, blocks, quiet: false };
}

function renderEvidence(rows: HypothesisEvidence[]): string {
  return rows
    .map((r) => `${r.field}=${r.value}${r.threshold != null ? ` (vs ${r.threshold})` : ""}`)
    .join(", ");
}

// ── Guard — assert every proposal is owner-gated and at draft ────────────────

/**
 * Runtime guard the WORKER calls before inserting proposals via the SDK. A
 * proposal that fails this refuses the write — never serves, never spends.
 * Cite it in the diff as the compare-and-set predicate (the "guard before
 * mutation" [[../operational-rules]] rule).
 */
export function assertProposalOwnerGatedDraft(p: ProposedExperiment): void {
  if (p.status !== PROPOSAL_STATUS_DRAFT) {
    throw new Error(`assertProposalOwnerGatedDraft: refusing non-draft status=${p.status} for cohort=${p.cohort}`);
  }
  if (p.owner_gated !== true) {
    throw new Error(`assertProposalOwnerGatedDraft: refusing non-owner-gated proposal for cohort=${p.cohort}`);
  }
}
