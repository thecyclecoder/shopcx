/**
 * Phase-4 unit tests for the side-by-side QC gate
 * (dahlia-competitor-ad-adaptation-overlay-render). Pins the deterministic surface: the
 * side-by-side composite is [competitor | ours] at exactly `2 × halfWidth + dividerPx`
 * (no cropping, both halves letterboxed to the same canvas), the psychological-structure
 * beat enum is stable, and the pure `sideBySideGate` predicate fails on either axis
 * (energy or structure) or a critical issue — mirroring the prime directive: ship only
 * when ours ties or wins on visual energy AND preserved structure.
 *
 * Run: npx tsx --test src/lib/ads/creative-side-by-side.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  buildSideBySide,
  SIDE_BY_SIDE_QC_STRUCTURE,
  sideBySideGate,
  type SideBySideVerdict,
} from "./creative-side-by-side";

async function makeSolidJpeg(w: number, h: number, rgb: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: rgb } }).jpeg().toBuffer();
}

// ── SIDE_BY_SIDE_QC_STRUCTURE (grep-token for the qc-gate verification) ──────

test("SIDE_BY_SIDE_QC_STRUCTURE: carries the 5 beats of the preserved psychological structure verbatim", () => {
  assert.deepEqual(
    [...SIDE_BY_SIDE_QC_STRUCTURE],
    ["hook", "regret", "benefit_stack", "social_proof_payoff", "risk_reversal"],
    "the enum is the source of truth for the vision judge's structure axis",
  );
});

// ── buildSideBySide (pure sharp composite) ──────────────────────────────────

test("buildSideBySide: [competitor | ours] composite is 2 × halfWidth + dividerPx (both halves letterboxed to the same canvas)", async () => {
  const competitor = await makeSolidJpeg(1080, 1350, { r: 200, g: 30, b: 40 });
  const ours = await makeSolidJpeg(1080, 1350, { r: 30, g: 200, b: 40 });
  const { buffer, mimeType } = await buildSideBySide(competitor, ours, { ratio: "4:5" });
  assert.equal(mimeType, "image/jpeg");
  const meta = await sharp(buffer).metadata();
  // 4:5 half = 1080 × 1350. Composite: 1080*2 + 8 (default divider) = 2168 wide.
  assert.equal(meta.width, 2168);
  assert.equal(meta.height, 1350);
  assert.equal(meta.format, "jpeg");
});

test("buildSideBySide: 9:16 ratio produces per-half 1080×1920 halves (no cropping, letterboxed)", async () => {
  // A landscape competitor reference (1920×1080) must be LETTERBOXED to 1080×1920 (not cropped) so
  // the design language we're grading against isn't erased.
  const competitor = await makeSolidJpeg(1920, 1080, { r: 200, g: 30, b: 40 });
  const ours = await makeSolidJpeg(1080, 1920, { r: 30, g: 200, b: 40 });
  const { buffer } = await buildSideBySide(competitor, ours, { ratio: "9:16" });
  const meta = await sharp(buffer).metadata();
  assert.equal(meta.width, 1080 * 2 + 8, "1080 × 2 + 8 divider");
  assert.equal(meta.height, 1920);
});

test("buildSideBySide: outputMime='image/png' honours the encoding switch", async () => {
  const a = await makeSolidJpeg(400, 500, { r: 20, g: 20, b: 20 });
  const b = await makeSolidJpeg(400, 500, { r: 220, g: 220, b: 220 });
  const { buffer, mimeType } = await buildSideBySide(a, b, { ratio: "4:5", outputMime: "image/png" });
  assert.equal(mimeType, "image/png");
  const meta = await sharp(buffer).metadata();
  assert.equal(meta.format, "png");
});

test("buildSideBySide: custom dividerPx widens the composite by exactly that many pixels", async () => {
  const a = await makeSolidJpeg(400, 500, { r: 0, g: 0, b: 0 });
  const b = await makeSolidJpeg(400, 500, { r: 255, g: 255, b: 255 });
  const { buffer } = await buildSideBySide(a, b, { ratio: "4:5", dividerPx: 32 });
  const meta = await sharp(buffer).metadata();
  assert.equal(meta.width, 1080 * 2 + 32, "dividerPx=32 → composite width 1080*2+32");
});

// ── sideBySideGate (deterministic pass/fail) ─────────────────────────────────

test("sideBySideGate: PASS when both axes are true AND no critical issue is flagged", () => {
  const verdict: SideBySideVerdict = {
    energyMatchOrSurpass: true,
    structurePreserved: true,
  };
  const g = sideBySideGate(verdict);
  assert.equal(g.pass, true);
  assert.deepEqual(g.reasons, []);
});

test("sideBySideGate: FAIL on weak energy (mirrors the prime-directive 'match or surpass' rule)", () => {
  const g = sideBySideGate({ energyMatchOrSurpass: false, structurePreserved: true });
  assert.equal(g.pass, false);
  assert.ok(g.reasons.some((r) => /side_by_side_energy_below_source/.test(r)), `expected energy fail reason; got ${JSON.stringify(g.reasons)}`);
});

test("sideBySideGate: FAIL on structure miss NAMES the missing beat(s) so the outer regen loop's revise reason is concrete", () => {
  const g = sideBySideGate({
    energyMatchOrSurpass: true,
    structurePreserved: false,
    missingBeats: ["regret", "risk_reversal"],
  });
  assert.equal(g.pass, false);
  assert.ok(g.reasons.some((r) => /side_by_side_structure_missing/.test(r)));
  assert.ok(g.reasons.some((r) => /regret/.test(r) && /risk_reversal/.test(r)), "revise reason names which beats are missing");
});

test("sideBySideGate: an unknown beat in missingBeats is IGNORED (deterministic — protects the enum)", () => {
  const g = sideBySideGate({
    energyMatchOrSurpass: true,
    structurePreserved: false,
    // deliberately invalid values slipped in from a wobbly judge parse
    missingBeats: ["hook", "not_a_beat"] as never,
  });
  assert.equal(g.pass, false);
  // Only 'hook' survives the filter — 'not_a_beat' is silently dropped.
  const structureReason = g.reasons.find((r) => /side_by_side_structure_missing/.test(r)) ?? "";
  assert.ok(/hook/.test(structureReason));
  assert.ok(!/not_a_beat/.test(structureReason), "invalid beat is filtered out");
});

test("sideBySideGate: critical issue lines are lifted into the reasons list", () => {
  const g = sideBySideGate({
    energyMatchOrSurpass: true,
    structurePreserved: true,
    issues: ["competitor brand still visible in bottom-right", "  ", ""],
  });
  assert.equal(g.pass, false, "any critical issue fails the gate");
  assert.ok(g.reasons.some((r) => /competitor brand still visible/.test(r)));
  // Empty / whitespace-only issue strings are skipped so a noisy judge output can't spam noise.
  assert.equal(g.reasons.filter((r) => /side_by_side_issue/.test(r)).length, 1);
});

test("sideBySideGate: FAIL on BOTH axes surfaces BOTH reasons for the audit trail", () => {
  const g = sideBySideGate({
    energyMatchOrSurpass: false,
    structurePreserved: false,
    missingBeats: ["benefit_stack"],
  });
  assert.equal(g.pass, false);
  assert.ok(g.reasons.some((r) => /energy_below_source/.test(r)));
  assert.ok(g.reasons.some((r) => /structure_missing/.test(r)));
  assert.equal(g.reasons.length, 2, "one reason per failed axis");
});
