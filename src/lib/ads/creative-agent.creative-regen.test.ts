/**
 * creative-agent.creative-regen — pin-tests for the max-qc-grades-the-creative-per-format-
 * not-just-a-binary-render-ok Phase 2 wire-in:
 *
 *   (1) buildCopyQcPromptPreamble emits a FORMATS: block ABOVE the DATA fence when the caller
 *       hands per-format image paths (Max Reads each listed path + emits one `creative[]`
 *       entry per format). When formats is omitted or empty, no FORMATS block appears
 *       (legacy single-image call — byte-identical to Phase 1).
 *   (2) The FORMATS block lists every format the caller passed with format→path in the order
 *       given, so a divergence between the SKILL's documented schema + the runtime bytes is
 *       caught in-source.
 *   (3) failedFormatsFromCreativeVerdict extracts the failing format keys from a per-format
 *       verdict — this is the seed the creative-regen loop iterates over to regen the offending
 *       renders. A gate-pass verdict returns []. A legacy verdict with `creative:null` returns
 *       [] (nothing to regen).
 *   (4) MAX_CREATIVE_QC_ATTEMPTS is >=2 (initial + at least one regen bounce).
 *
 * Runs via: npx tsx --test src/lib/ads/creative-agent.creative-regen.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCopyQcPromptPreamble,
  failedFormatsFromCreativeVerdict,
  MAX_CREATIVE_QC_ATTEMPTS,
} from "./creative-agent";
import type { CopyQaVerdict } from "./creative-qa";

function preambleInputs(): Parameters<typeof buildCopyQcPromptPreamble>[0] {
  return {
    copy: { headline: "H", primaryText: "P", description: "D" },
    brief: { imageRefs: [], productTitle: "Superfood Tabs", supportingBenefits: [], proofStack: [] } as unknown as Parameters<typeof buildCopyQcPromptPreamble>[0]["brief"],
    rubricText: "# rubric — fixture",
    audienceTemperature: "warm",
    targetSchwartzLevel: 3,
    marketSophisticationEvidence: [],
    dahliaSelfScore: { lf8: 2, schwartz: 2, cialdini: 2, hopkins: 2, sugarman: 2, total: 10, evidence: [] },
  };
}

test("(1a) buildCopyQcPromptPreamble: no formats → no FORMATS block emitted (byte-identical to Phase 1)", () => {
  const prompt = buildCopyQcPromptPreamble(preambleInputs());
  assert.equal(prompt.includes("FORMATS ("), false, "the trusted FORMATS: block must be absent on a legacy call");
});

test("(1b) buildCopyQcPromptPreamble: empty formats array → no FORMATS block emitted (defensive parity with omitted)", () => {
  const prompt = buildCopyQcPromptPreamble({ ...preambleInputs(), formats: [] });
  assert.equal(prompt.includes("FORMATS ("), false);
});

test("(2) buildCopyQcPromptPreamble: formats array → FORMATS block emitted with format:path pairs above the DATA fence, in order", () => {
  const prompt = buildCopyQcPromptPreamble({
    ...preambleInputs(),
    formats: [
      { format: "feed_4x5", path: "/tmp/creative-copy-qc-run-feed_4x5.jpg" },
      { format: "stories_9x16", path: "/tmp/creative-copy-qc-run-stories_9x16.jpg" },
      { format: "right_column_1x1", path: "/tmp/creative-copy-qc-run-right_column_1x1.jpg" },
    ],
  });
  // The FORMATS: block must appear (Max reads it to decide which paths to Read).
  assert.match(prompt, /FORMATS \(worker-computed, trusted/);
  // Every format + its path must be present so Max can locate the tmp jpegs.
  assert.match(prompt, /format: feed_4x5\s+path: \/tmp\/creative-copy-qc-run-feed_4x5\.jpg/);
  assert.match(prompt, /format: stories_9x16\s+path: \/tmp\/creative-copy-qc-run-stories_9x16\.jpg/);
  assert.match(prompt, /format: right_column_1x1\s+path: \/tmp\/creative-copy-qc-run-right_column_1x1\.jpg/);
  // The FORMATS: block must land ABOVE the DATA fence so it's trusted (not opaque data).
  assert.ok(prompt.indexOf("FORMATS (") < prompt.indexOf("===BEGIN_COPY_QC_DATA_v1==="));
});

test("(3a) failedFormatsFromCreativeVerdict: a per-format entry with any check false → its format is returned", () => {
  const verdict = {
    creative: [
      {
        format: "feed_4x5",
        product_scale_ok: true,
        no_hallucinated_offer_or_badge: false,
        no_in_pixel_competitor_leak: true,
        on_image_text_legible: true,
        findings: ["feed 4:5: fabricated 'FREE TOTE' badge baked into the render"],
      },
      {
        format: "stories_9x16",
        product_scale_ok: true,
        no_hallucinated_offer_or_badge: true,
        no_in_pixel_competitor_leak: true,
        on_image_text_legible: true,
        findings: [],
      },
    ],
    creative_gate_pass: false,
  } as unknown as CopyQaVerdict;
  const failed = failedFormatsFromCreativeVerdict(verdict);
  assert.deepEqual(failed, ["feed_4x5"], "the failing format's key surfaces; the clean sibling does not");
});

test("(3b) failedFormatsFromCreativeVerdict: creative_gate_pass=true → returns [] (nothing to regen)", () => {
  const verdict = {
    creative: [
      {
        format: "feed_4x5",
        product_scale_ok: true,
        no_hallucinated_offer_or_badge: true,
        no_in_pixel_competitor_leak: true,
        on_image_text_legible: true,
        findings: [],
      },
    ],
    creative_gate_pass: true,
  } as unknown as CopyQaVerdict;
  assert.deepEqual(failedFormatsFromCreativeVerdict(verdict), []);
});

test("(3c) failedFormatsFromCreativeVerdict: legacy verdict with creative:null → returns [] (no per-format signal)", () => {
  const verdict = { creative: null, creative_gate_pass: true } as unknown as CopyQaVerdict;
  assert.deepEqual(failedFormatsFromCreativeVerdict(verdict), []);
});

test("(3d) failedFormatsFromCreativeVerdict: multiple failing formats surface in list order (regen loop iterates in the same order)", () => {
  const verdict = {
    creative: [
      {
        format: "feed_4x5",
        product_scale_ok: false,
        no_hallucinated_offer_or_badge: true,
        no_in_pixel_competitor_leak: true,
        on_image_text_legible: true,
        findings: ["feed 4:5: bottle stretched to twice its shelf height"],
      },
      {
        format: "stories_9x16",
        product_scale_ok: true,
        no_hallucinated_offer_or_badge: true,
        no_in_pixel_competitor_leak: false,
        on_image_text_legible: true,
        findings: ["stories 9:16: rival wordmark rendered visibly in the frame"],
      },
    ],
    creative_gate_pass: false,
  } as unknown as CopyQaVerdict;
  assert.deepEqual(failedFormatsFromCreativeVerdict(verdict), ["feed_4x5", "stories_9x16"]);
});

test("(4) MAX_CREATIVE_QC_ATTEMPTS: at least 2 (initial + one regen bounce, per the spec 'attempt cap' — mirrors the copy-fail bounce)", () => {
  assert.ok(MAX_CREATIVE_QC_ATTEMPTS >= 2, `expected >=2 attempts, got ${MAX_CREATIVE_QC_ATTEMPTS}`);
});
