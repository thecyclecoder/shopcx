/**
 * creative-qa Phase 2 — Max grades Dahlia's creative INTENT-AWARE on the 5-axis rubric.
 * Pins the dahlia-researches-from-winners-flow-ad-library Phase 2 invariants:
 *
 *   1. `parseCopyQaVerdict` accepts a verdict CARRYING declared_intent + a 5-axis
 *      dahlia_rubric → the parsed CopyQaVerdict has both fields populated with the
 *      declared audience_temperature echoed back + each axis's { score, reason }.
 *   2. A verdict with declared_intent='cold' emits ALL 5 rubric axes with scores + reasons
 *      that ground themselves in the declared temperature (grades competitor + temperature
 *      FIT against 'cold').
 *   3. `insertCopyQaVerdict` writes declared_intent + dahlia_rubric on the row body so the
 *      grade ledger carries them (exactly one row per QC attempt).
 *   4. A MALFORMED dahlia_rubric fails closed with a per-axis reason.
 *   5. Absence of declared_intent + dahlia_rubric is TOLERATED (legacy verdict parses
 *      byte-identical to today's behavior with both fields null).
 *   6. `renderMaxDahliaRubricTrustedContext` emits the intent-aware TRUSTED CONTEXT block
 *      the QC prompt inlines when the caller threads a declared intent; empty string when
 *      no intent is declared.
 *   7. `runQaCreativeCopyViaBoxSession` inlines the block into the prompt handed to the
 *      dispatcher so Max sees the declared intent + benchmark before scoring.
 *
 * Pure — no network, no live DB. Runs via:
 *   npx tsx --test src/lib/ads/creative-qa.dahlia-rubric.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCopyQaVerdict,
  parseDahliaRubric,
  parseDeclaredIntent,
  renderMaxDahliaRubricTrustedContext,
  runQaCreativeCopyViaBoxSession,
  insertCopyQaVerdict,
  DAHLIA_RUBRIC_AXES,
  type CopyQaDeclaredIntent,
  type CopyQaVerdict,
  type DahliaRubricBenchmark,
  type QaCreativeCopyBoxSessionInput,
} from "./creative-qa";
import type { CreativeBrief } from "./creative-brief";

// ── shared fixtures ────────────────────────────────────────────────────────

const passVerdictWithIntentAndRubric = {
  hard_gate_pass: true,
  hard_gates: {
    no_fabrication: true,
    no_cold_offer: true,
    no_competitor_leak: true,
    single_promise: true,
    render_ok: true,
  },
  persuasion_score: 8,
  persuasion_rubric: {
    lf8: 2,
    schwartz: 1,
    cialdini: 2,
    hopkins: 1,
    sugarman: 2,
    evidence: ["scroll-stopping objection frame · adaptogen mechanism claim"],
  },
  scroll_stop: {
    headline_readable_in_3_frames: 2,
    visual_hierarchy_supports_headline: 2,
    first_line_earns_the_second: 2,
    evidence: ["headline_readable_in_3_frames: 'Ditch the 3pm crash' set large"],
  },
  declared_intent: { audience_temperature: "cold", purpose: "test-to-find-winner" },
  dahlia_rubric: {
    competitor_selection: {
      score: 9,
      reason:
        "Winner concept is unaware/problem_aware — the right cold-audience pick for the declared 'cold' temperature.",
    },
    temperature_selection: {
      score: 8,
      reason:
        "Cold ad leads with a curiosity/objection hook and no offer/urgency — matches the declared 'cold' temperature.",
    },
    creative_quality: { score: 7, reason: "Hierarchy clear; secondary line supports the promise; pack legible." },
    scroll_stopping: {
      score: 8,
      reason: "Headline earns the second line — pattern-interrupt hook fits the first 3 frames.",
    },
    dr_consumer_psychology: {
      score: 8,
      reason: "LF8 energy/status hits; Schwartz problem-aware stage-fit; Cialdini authority + social proof stack.",
    },
  },
  verdict_reason: "ok — clean render + intent-aware persuasion at a cold-audience benchmark",
};

// ── 1. parseCopyQaVerdict surfaces the Phase 2 fields ────────────────────

test("(P2-1) parseCopyQaVerdict: verdict carrying declared_intent + dahlia_rubric → both fields populated on the parsed verdict", () => {
  const parsed = parseCopyQaVerdict(JSON.stringify(passVerdictWithIntentAndRubric));
  assert.equal(parsed.kind, "ok");
  if (parsed.kind !== "ok") return;
  const v: CopyQaVerdict = parsed.verdict;
  assert.deepEqual(v.declared_intent, { audience_temperature: "cold", purpose: "test-to-find-winner" });
  assert.ok(v.dahlia_rubric, "dahlia_rubric populated");
  for (const axis of DAHLIA_RUBRIC_AXES) {
    const score = v.dahlia_rubric![axis].score;
    const reason = v.dahlia_rubric![axis].reason;
    assert.ok(Number.isInteger(score) && score >= 1 && score <= 10, `${axis}.score is an int 1..10 (${score})`);
    assert.ok(reason.length > 0, `${axis}.reason non-empty`);
  }
  // Intent-aware axes explicitly cite the declared cold temperature.
  assert.match(v.dahlia_rubric!.competitor_selection.reason, /cold/i);
  assert.match(v.dahlia_rubric!.temperature_selection.reason, /cold/i);
});

// ── 2. Persistence — the writer hands both fields to the admin client ──────

test("(P2-2) insertCopyQaVerdict: writes declared_intent + dahlia_rubric on the row body (exactly one row per QC attempt)", async () => {
  const parsed = parseCopyQaVerdict(JSON.stringify(passVerdictWithIntentAndRubric));
  assert.equal(parsed.kind, "ok");
  if (parsed.kind !== "ok") return;
  let inserts = 0;
  let capturedBody: Record<string, unknown> | null = null;
  const fakeAdmin = {
    from(_table: string) {
      return {
        insert(body: Record<string, unknown>) {
          inserts++;
          capturedBody = body;
          return {
            select(_cols: string) {
              return {
                async single() {
                  return { data: { id: "verdict-p2-uuid" }, error: null };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as Parameters<typeof insertCopyQaVerdict>[0];
  const result = await insertCopyQaVerdict(fakeAdmin, {
    workspaceId: "ws-1",
    adCampaignId: "camp-cold-1",
    verdict: parsed.verdict,
    retryIndex: 0,
  });
  assert.deepEqual(result, { id: "verdict-p2-uuid" });
  assert.equal(inserts, 1, "exactly one row inserted per QC attempt");
  assert.ok(capturedBody);
  const body = capturedBody as unknown as Record<string, unknown>;
  assert.deepEqual(body.declared_intent, { audience_temperature: "cold", purpose: "test-to-find-winner" });
  const rubric = body.dahlia_rubric as Record<string, { score: number; reason: string }>;
  for (const axis of DAHLIA_RUBRIC_AXES) {
    assert.ok(Number.isInteger(rubric[axis].score) && rubric[axis].score >= 1 && rubric[axis].score <= 10);
    assert.ok(rubric[axis].reason.length > 0);
  }
});

// ── 3. Fail-closed on a malformed rubric ────────────────────────────────

test("(P2-3) parseDahliaRubric: missing axis → parse_error (fail-closed) naming the axis", () => {
  const missing = {
    competitor_selection: { score: 8, reason: "cold-aware winner" },
    creative_quality: { score: 7, reason: "clean" },
    scroll_stopping: { score: 8, reason: "earns line 2" },
    dr_consumer_psychology: { score: 8, reason: "LF8+cialdini" },
  };
  const parsed = parseDahliaRubric(missing);
  assert.equal(parsed.kind, "parse_error");
  if (parsed.kind === "parse_error") assert.match(parsed.reason, /temperature_selection/);
});

test("(P2-3) parseDahliaRubric: score out of 1..10 → parse_error naming the axis", () => {
  const outOfRange = {
    competitor_selection: { score: 11, reason: "over-10" },
    temperature_selection: { score: 5, reason: "ok" },
    creative_quality: { score: 5, reason: "ok" },
    scroll_stopping: { score: 5, reason: "ok" },
    dr_consumer_psychology: { score: 5, reason: "ok" },
  };
  const parsed = parseDahliaRubric(outOfRange);
  assert.equal(parsed.kind, "parse_error");
  if (parsed.kind === "parse_error") assert.match(parsed.reason, /competitor_selection.*score_out_of_range/);
});

test("(P2-3) parseDahliaRubric: empty reason → parse_error naming the axis", () => {
  const emptyReason = {
    competitor_selection: { score: 8, reason: "" },
    temperature_selection: { score: 5, reason: "ok" },
    creative_quality: { score: 5, reason: "ok" },
    scroll_stopping: { score: 5, reason: "ok" },
    dr_consumer_psychology: { score: 5, reason: "ok" },
  };
  const parsed = parseDahliaRubric(emptyReason);
  assert.equal(parsed.kind, "parse_error");
  if (parsed.kind === "parse_error") assert.match(parsed.reason, /competitor_selection.*reason_missing/);
});

// ── 4. Backcompat — absence tolerated ──────────────────────────────────

test("(P2-4) parseCopyQaVerdict: legacy verdict WITHOUT declared_intent + dahlia_rubric → parse ok with both fields null", () => {
  const legacy = { ...passVerdictWithIntentAndRubric } as Record<string, unknown>;
  delete legacy.declared_intent;
  delete legacy.dahlia_rubric;
  const parsed = parseCopyQaVerdict(JSON.stringify(legacy));
  assert.equal(parsed.kind, "ok");
  if (parsed.kind !== "ok") return;
  assert.equal(parsed.verdict.declared_intent, null);
  assert.equal(parsed.verdict.dahlia_rubric, null);
  assert.equal(parsed.verdict.hard_gate_pass, true);
});

test("(P2-4) parseDeclaredIntent: bad audience_temperature → normalizes to the run's target temperature (max-copy-qc-verdict-parser-is-tolerant Phase 1)", () => {
  // A wobbly temperature literal (e.g. "lukewarm") no longer discards Max's whole verdict —
  // it normalizes to the run's target (what Max was told the creative was authored for).
  const bad = { audience_temperature: "lukewarm", purpose: "test-to-find-winner" };
  const parsed = parseDeclaredIntent(bad, "cold");
  assert.equal(parsed.kind, "ok");
  if (parsed.kind === "ok") {
    assert.deepEqual(parsed.value, { audience_temperature: "cold", purpose: "test-to-find-winner" });
  }
  // No run-target provided → defaults to "warm" (safe centre) so a legacy caller keeps
  // getting a usable verdict.
  const parsedNoTarget = parseDeclaredIntent(bad);
  assert.equal(parsedNoTarget.kind, "ok");
  if (parsedNoTarget.kind === "ok") {
    assert.equal(parsedNoTarget.value?.audience_temperature, "warm");
  }
});

// ── 5. TRUSTED CONTEXT block ────────────────────────────────────────────

test("(P2-5) renderMaxDahliaRubricTrustedContext: emits a fenced block naming the temperature + rubric axes", () => {
  const block = renderMaxDahliaRubricTrustedContext({
    declaredIntent: { audience_temperature: "cold", purpose: "test-to-find-winner" },
    benchmark: {
      competitor_advertiser: "MUD\\WTR",
      concept_tags: {
        angle: "clean energy no crash",
        archetype: "problem-agitate-solve",
        why_it_works: "the 3pm crash pattern is instantly recognizable",
        cialdini_lever: "authority",
        awareness_stage: "problem_aware",
        format: "static_image",
      },
    },
  });
  assert.match(block, /BEGIN_DAHLIA_INTENT_TRUSTED_CONTEXT_v1/);
  assert.match(block, /DECLARED_AUDIENCE_TEMPERATURE: cold/);
  assert.match(block, /DECLARED_PURPOSE: test-to-find-winner/);
  for (const axis of DAHLIA_RUBRIC_AXES) {
    assert.match(block, new RegExp(axis));
  }
  assert.match(block, /awareness_stage: problem_aware/);
  assert.match(block, /archetype: problem-agitate-solve/);
});

test("(P2-5) renderMaxDahliaRubricTrustedContext: null declaredIntent → empty string (byte-identical prompt)", () => {
  const block = renderMaxDahliaRubricTrustedContext({ declaredIntent: null });
  assert.equal(block, "");
});

test("(P2-5) renderMaxDahliaRubricTrustedContext: own-brand angle (benchmark null) → block present, benchmark section names 'no winner-library breakdown'", () => {
  const block = renderMaxDahliaRubricTrustedContext({
    declaredIntent: { audience_temperature: "warm", purpose: "test-to-find-winner" },
    benchmark: null,
  });
  assert.match(block, /DECLARED_AUDIENCE_TEMPERATURE: warm/);
  assert.match(block, /no winner-library breakdown/);
});

// ── 6. Session runner ──────────────────────────────────────────────────

test("(P2-6) runQaCreativeCopyViaBoxSession: dispatcher receives the intent-aware block when declaredIntent is threaded", async () => {
  let dispatchedPrompt = "";
  const dispatcher = async (prompt: string, _img: string) => {
    dispatchedPrompt = prompt;
    return { resultText: "ok", isError: false };
  };
  const brief = {
    productTitle: "Superfood Coffee",
    angle: {
      hook: "Ditch the 3pm crash",
      source: "competitor",
      leadBenefit: "clean sustained energy",
      acquisitionPower: 9,
      retentionTruth: 5,
      commodity: false,
      hasRealPhoto: false,
      reasons: [],
    },
    leadProof: null,
    transformation: null,
    supportingBenefits: [],
    proofStack: [],
    offer: null,
    imageRefs: [],
    guardrails: [],
  } as unknown as CreativeBrief;
  const declaredIntent: CopyQaDeclaredIntent = { audience_temperature: "cold", purpose: "test-to-find-winner" };
  const benchmark: DahliaRubricBenchmark = {
    competitor_advertiser: "MUD\\WTR",
    concept_tags: {
      angle: "clean energy no crash",
      archetype: "problem-agitate-solve",
      why_it_works: "the 3pm crash pattern is instantly recognizable",
      cialdini_lever: "authority",
      awareness_stage: "problem_aware",
      format: "static_image",
    },
  };
  const input: QaCreativeCopyBoxSessionInput = {
    copy: {
      headline: "Ditch the 3pm crash",
      primaryText: "Clean, sustained energy — no jitters.",
      description: "Get started.",
    },
    brief,
    context: {
      audience_temperature: "cold",
      competitorAdvertisers: ["MUD\\WTR"],
      ourBrand: "Superfoods Company",
    },
    imagePath: "/tmp/fake-ad.jpg",
    declaredIntent,
    dahliaRubricBenchmark: benchmark,
  };
  const outcome = await runQaCreativeCopyViaBoxSession(input, dispatcher);
  assert.equal(outcome.kind, "ok");
  assert.match(dispatchedPrompt, /BEGIN_DAHLIA_INTENT_TRUSTED_CONTEXT_v1/);
  assert.match(dispatchedPrompt, /DECLARED_AUDIENCE_TEMPERATURE: cold/);
  assert.match(dispatchedPrompt, /BEGIN_VALIDATOR_TRUSTED_CONTEXT_v1/);
  assert.match(dispatchedPrompt, /archetype: problem-agitate-solve/);
});

test("(P2-6) runQaCreativeCopyViaBoxSession: no declaredIntent → no intent block in the prompt (byte-identical to M1)", async () => {
  let dispatchedPrompt = "";
  const dispatcher = async (prompt: string, _img: string) => {
    dispatchedPrompt = prompt;
    return { resultText: "ok", isError: false };
  };
  const brief = { imageRefs: [] } as unknown as CreativeBrief;
  const input: QaCreativeCopyBoxSessionInput = {
    copy: { headline: "H", primaryText: "P", description: "D" },
    brief,
    context: { audience_temperature: "cold", competitorAdvertisers: [], ourBrand: "Us" },
    imagePath: "/tmp/x.jpg",
  };
  await runQaCreativeCopyViaBoxSession(input, dispatcher);
  assert.doesNotMatch(dispatchedPrompt, /BEGIN_DAHLIA_INTENT_TRUSTED_CONTEXT_v1/);
  assert.match(dispatchedPrompt, /BEGIN_VALIDATOR_TRUSTED_CONTEXT_v1/);
});
