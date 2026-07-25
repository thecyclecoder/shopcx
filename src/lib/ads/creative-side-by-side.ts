/**
 * creative-side-by-side — the side-by-side QC gate for Dahlia's overlay render path
 * (dahlia-competitor-ad-adaptation-overlay-render Phase 4). The **prime directive** in
 * [[../../../docs/brain/reference/competitor-ad-adaptation]] is the side-by-side: "Adapt
 * against a live side-by-side of the competitor ad, never in isolation. Without it you drift
 * toward YOUR graphic and quietly lose the very things that made theirs convert." So an
 * adapted creative doesn't LAND until it renders beside the competitor skeleton and a vision
 * judge grades it on (a) energy match-or-surpass and (b) preserved psychological structure
 * (hook → regret → benefit stack → social-proof payoff → risk-reversal).
 *
 * This module owns the deterministic surface:
 *   • `buildSideBySide` — pure sharp composite: [competitor | ours], normalized to a shared
 *     canvas so the vision judge sees equal-size halves;
 *   • `SIDE_BY_SIDE_QC_STRUCTURE` — the enumerated psychological-structure beats a preserved
 *     imitation must carry (grep-token for the qc-gate verification);
 *   • `SideBySideVerdict` — the typed shape a vision judge returns (energy + structure axes +
 *     issues[]);
 *   • `sideBySideGate(verdict)` — pure predicate: pass iff BOTH axes are true AND no critical
 *     issue was flagged; on fail, the outer MAX_QA_ATTEMPTS regen loop in
 *     [[creative-agent]] takes another attempt (mirrors the existing vision-QC bounce, per
 *     Part 3 of the spec).
 *
 * Callers: [[creative-generate]] `generateCreative` overlay branch returns the side-by-side
 * buffer alongside the composited output so the outer loop can hand it to the vision judge;
 * the judge's verdict is fed to `sideBySideGate` to decide land-vs-revise.
 */
import sharp from "sharp";
import type { NanoBananaAspect } from "@/lib/gemini";

/** Nominal per-half canvas sizes for the side-by-side composite (matches Meta ad specs for
 *  each placement ratio; the composite doubles the width). */
const HALF_CANVAS: Record<NanoBananaAspect, { w: number; h: number }> = {
  "1:1": { w: 1080, h: 1080 },
  "4:5": { w: 1080, h: 1350 },
  "9:16": { w: 1080, h: 1920 },
  "16:9": { w: 1920, h: 1080 },
  "2:3": { w: 1080, h: 1620 },
  "3:2": { w: 1620, h: 1080 },
  "3:4": { w: 1080, h: 1440 },
  "4:3": { w: 1440, h: 1080 },
  "5:4": { w: 1350, h: 1080 },
  "21:9": { w: 2100, h: 900 },
};

/**
 * The enumerated PSYCHOLOGICAL STRUCTURE the imitation must preserve on the side-by-side
 * (the worked SpoiledChild "SORRY IN ADVANCE" → Amazing Creamer trace, verbatim from
 * [[../../../docs/brain/reference/competitor-ad-adaptation]] Part 3): a hook that stops the
 * scroll, a regret / sub-headline that names the discomfort, a benefit stack that promises
 * the outcome, a social-proof payoff, and a risk-reversal close. A missing beat fails the
 * structure axis of the gate — the vision judge is asked to name which beat is absent, and
 * `sideBySideGate` lifts the miss into the outer regen loop's reason string.
 *
 * Grep-token for the qc-gate verification. Consumed by the vision judge's prompt (via
 * [[creative-generate]] on the overlay path) and by [[creative-agent]]'s regen loop reason.
 */
export const SIDE_BY_SIDE_QC_STRUCTURE = [
  "hook",
  "regret",
  "benefit_stack",
  "social_proof_payoff",
  "risk_reversal",
] as const;

export type SideBySideStructureBeat = typeof SIDE_BY_SIDE_QC_STRUCTURE[number];

export interface SideBySideOpts {
  /** Output encoding — jpeg (default) or png. */
  outputMime?: "image/jpeg" | "image/png";
  /** Divider width in px between the two halves. Default 8. */
  dividerPx?: number;
  /** Divider color (SVG hex). Default '#ffffff'. */
  dividerColor?: string;
  /** Ratio hint — controls the per-half canvas size the two images are normalized to.
   *  When absent, the composite runs at the adapted image's natural size scaled to a
   *  matched-height pair. */
  ratio?: NanoBananaAspect;
}

/**
 * Build the [competitor | adapted] side-by-side composite. Deterministic: both images are
 * resized (`fit: contain`, black letterbox background) to the same per-half canvas so the
 * vision judge sees equal halves, then composited horizontally with a thin white divider.
 * Never crops either half — a cropped competitor reference would erase the design language
 * we're grading against.
 */
export async function buildSideBySide(
  competitorImage: Buffer,
  adaptedImage: Buffer,
  opts: SideBySideOpts = {},
): Promise<{ buffer: Buffer; mimeType: string }> {
  const ratio = opts.ratio ?? "4:5";
  const canvas = HALF_CANVAS[ratio];
  const half = { w: canvas.w, h: canvas.h };
  const dividerPx = opts.dividerPx ?? 8;
  const dividerColor = opts.dividerColor ?? "#ffffff";
  const wantPng = opts.outputMime === "image/png";

  // Normalize each half to the per-ratio canvas. `fit: contain` preserves aspect (letterboxes
  // with black) so a mismatched-ratio competitor reference is NEVER cropped — cropping the
  // competitor erases the design language the gate is meant to grade against.
  const [leftHalf, rightHalf] = await Promise.all([
    sharp(competitorImage)
      .resize(half.w, half.h, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 1 } })
      .removeAlpha()
      .toBuffer(),
    sharp(adaptedImage)
      .resize(half.w, half.h, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 1 } })
      .removeAlpha()
      .toBuffer(),
  ]);

  const totalW = half.w * 2 + dividerPx;
  const totalH = half.h;
  const divider = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${dividerPx}" height="${totalH}" viewBox="0 0 ${dividerPx} ${totalH}"><rect x="0" y="0" width="${dividerPx}" height="${totalH}" fill="${dividerColor}"/></svg>`);
  const canvasPipeline = sharp({
    create: { width: totalW, height: totalH, channels: 3, background: { r: 0, g: 0, b: 0 } },
  }).composite([
    { input: leftHalf, top: 0, left: 0 },
    { input: divider, top: 0, left: half.w },
    { input: rightHalf, top: 0, left: half.w + dividerPx },
  ]);
  const buffer = wantPng ? await canvasPipeline.png().toBuffer() : await canvasPipeline.jpeg({ quality: 90 }).toBuffer();
  return { buffer, mimeType: wantPng ? "image/png" : "image/jpeg" };
}

// ── Verdict + gate ──────────────────────────────────────────────────────────

/**
 * The typed shape a vision judge returns after grading the side-by-side. Two axes:
 *
 *   • `energyMatchOrSurpass` — TRUE iff our adaptation matches or SURPASSES the competitor
 *     on visual energy (contrast, scroll-stop, hierarchy density). Weaker energy fails.
 *   • `structurePreserved` — TRUE iff the imitation still carries every beat in
 *     `SIDE_BY_SIDE_QC_STRUCTURE`; on FALSE the `missingBeats` array names which beats are
 *     absent (`hook` / `regret` / `benefit_stack` / `social_proof_payoff` / `risk_reversal`).
 *
 * `issues[]` is a free-form list of concrete misses the vision judge saw (the same shape the
 * existing vision-QC verdicts use, so a downstream reader / logger doesn't need a new path).
 */
export interface SideBySideVerdict {
  energyMatchOrSurpass: boolean;
  structurePreserved: boolean;
  /** Which `SIDE_BY_SIDE_QC_STRUCTURE` beats the judge saw as absent (empty when structurePreserved=true). */
  missingBeats?: SideBySideStructureBeat[];
  /** Free-form list of concrete critical misses the judge saw. */
  issues?: string[];
}

export interface SideBySideGateResult {
  pass: boolean;
  /** Human-readable failure reasons (empty when pass=true). Populates the outer
   *  MAX_QA_ATTEMPTS regen loop's `revise reason` string in [[creative-agent]]. */
  reasons: string[];
}

/**
 * Deterministic gate over a `SideBySideVerdict`. Pass iff BOTH axes are true; on fail, the
 * outer MAX_QA_ATTEMPTS regen loop takes another attempt (mirrors the existing vision-QC
 * bounce in [[creative-agent]] `stockProduct`). Pure. Grep-token for the qc-gate verification.
 *
 * The gate is deliberately strict: any critical `issues` line, weak-energy verdict, or missing
 * beat produces a fail — the prime directive says the side-by-side must "match or SURPASS" the
 * source, and a mid verdict silently drifts the adaptation into a weaker version.
 */
export function sideBySideGate(verdict: SideBySideVerdict): SideBySideGateResult {
  const reasons: string[] = [];
  if (!verdict.energyMatchOrSurpass) {
    reasons.push("side_by_side_energy_below_source: the adaptation reads weaker than the competitor on visual energy (contrast / hierarchy / scroll-stop) — regen with more energy");
  }
  if (!verdict.structurePreserved) {
    const missing = (verdict.missingBeats ?? []).filter((b) => SIDE_BY_SIDE_QC_STRUCTURE.includes(b));
    const beatsBlob = missing.length ? missing.join(", ") : "unspecified";
    reasons.push(`side_by_side_structure_missing: the imitation dropped the proven psychological structure — missing beat(s): ${beatsBlob}`);
  }
  for (const issue of verdict.issues ?? []) {
    if (typeof issue === "string" && issue.trim()) reasons.push(`side_by_side_issue: ${issue.trim()}`);
  }
  return { pass: reasons.length === 0, reasons };
}
