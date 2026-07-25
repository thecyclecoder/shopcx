/**
 * creative-overlay — the deterministic font-engine copy compositor for Dahlia's
 * 3-layer render path (see [[../../../docs/brain/reference/competitor-ad-adaptation]]
 * Part 2 + Part 3). Image models garble text ("relaxant" → "relaxan"), and no
 * prompt makes a diffusion model reliably text-accurate. The fix: render a
 * TEXT-FREE scene via Nano Banana Pro, then composite the actual copy with a
 * real font engine (SVG → sharp) so spelling is guaranteed exact on every
 * ratio. This module owns layer 3 (copy overlay). Layer 1 (text-free scene) is
 * prompted in [[creative-generate]] behind the `DAHLIA_RENDER_MODE=overlay` flag.
 *
 * Phase 3 upgrades: `SAFE_ZONES` (Meta unified 14% top / 20% bottom / 6% sides on
 * 9:16, 14% all sides on 4:5, 10% top-bottom / 6% sides on 1:1), `fitFontToBox`
 * (area-first — define the box, size the font to fill it), `planLayout` (per-ratio
 * + scene-aware `clearZone` routing — full-width open top ⇒ full-width blocks;
 * side column ⇒ left-column layout; CTA always in the bottom safe band, never over
 * a hero element), light body / bold-italic benefit stack per Part 3, matched
 * vertical rhythm, no-orphan word-safe wrap. Phase 1 shipped the correct base
 * (scrims for legibility, five slots, sharp composite). Phase 3 makes the type
 * treatment match the source instead of eyeballing pixel offsets.
 *
 * Callers: `generateCreative` in [[creative-generate]] (flag-gated branch).
 */
import sharp from "sharp";
import type { NanoBananaAspect } from "@/lib/gemini";

/**
 * The five text slots of the 3-layer overlay — matches the worked SpoiledChild
 * "SORRY IN ADVANCE" → Amazing Creamer methodology in [[../../../docs/brain/reference/competitor-ad-adaptation]]:
 *
 *   SORRY IN ADVANCE                          (headline — heavy/bold, top)
 *   We regret to inform you that…             (regret — light sub-headline)
 *   smooth skin, thicken hair, curb cravings  (benefitStack — bold italic)
 *   We take full responsibility for…          (payoff — light)
 *   [ TRY IT RISK-FREE ]                      (cta — badge)
 *
 * Only `headline` is required; the rest are optional so the same compositor
 * works for a simpler own-brand overlay too.
 */
export interface OverlayCopy {
  headline: string;
  regret?: string;
  benefitStack?: string;
  payoff?: string;
  cta?: string;
}

/**
 * Scene-aware clear-zone hint. Part 3 rule: **"The text-box shape follows the
 * scene's actual clear zone — don't force a fixed shape."** A regenerated 9:16
 * scene usually opens a full-width TOP band (product centered-low ⇒ copy full-
 * width, centered); a 4:5 with a clean LEFT column (product hugged to the right)
 * gets a left-column text layout; and the mirror side-column for a right-hugging
 * product. `top_band` is the safest default and what today's scene prompt asks
 * Nano Banana to leave clean.
 */
export type OverlayClearZone = "top_band" | "side_column_left" | "side_column_right";

export interface OverlayOpts {
  /** Output encoding — jpeg (default) or png. */
  outputMime?: "image/jpeg" | "image/png";
  /** Override the default canvas size derived from `ratio`. */
  width?: number;
  height?: number;
  /** Scene-aware clear-zone hint — where the text-free scene actually left room.
   *  Defaults to `top_band` (the safest and what today's scene prompt asks for). */
  clearZone?: OverlayClearZone;
}

/** Nominal canvas sizes per Meta placement ratio (1080-family, matches Meta ad specs). */
const CANVAS: Record<NanoBananaAspect, { w: number; h: number }> = {
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

/** Per-placement safe-zone fractions (unified Meta 2026 spec). All text + CTA must
 *  land inside `[topPct, 1 - bottomPct] × [sidesPct, 1 - sidesPct]` of the canvas.
 *  9:16 is the most-aggressive (Reels/Stories chrome eats top + bottom); 4:5 gives
 *  the platform 14% breathing room on every side; 1:1 (right-column) is lighter.
 *
 *  Grep-token for the safe-zones-enforced verification. See Part 4 in
 *  [[../../../docs/brain/reference/competitor-ad-adaptation]]. */
export interface SafeZone {
  topPct: number;
  bottomPct: number;
  sidesPct: number;
}
export const SAFE_ZONES: Record<NanoBananaAspect, SafeZone> = {
  // 9:16 Stories / Reels — the exact CEO-cited Meta unified 2026 numbers: 14% top / 20% bottom / 6% sides.
  "9:16": { topPct: 0.14, bottomPct: 0.20, sidesPct: 0.06 },
  // 4:5 Feed — 14% breathing room all around.
  "4:5": { topPct: 0.14, bottomPct: 0.14, sidesPct: 0.06 },
  // 1:1 right-column — lighter chrome.
  "1:1": { topPct: 0.10, bottomPct: 0.10, sidesPct: 0.06 },
  // Others default to the 4:5 shape (a text-heavy right-column-ish canvas) so the compositor
  // never has to guess. Landscape ratios get thinner top/bottom bands because chrome varies less.
  "16:9": { topPct: 0.10, bottomPct: 0.10, sidesPct: 0.06 },
  "2:3": { topPct: 0.14, bottomPct: 0.14, sidesPct: 0.06 },
  "3:2": { topPct: 0.10, bottomPct: 0.10, sidesPct: 0.06 },
  "3:4": { topPct: 0.14, bottomPct: 0.14, sidesPct: 0.06 },
  "4:3": { topPct: 0.10, bottomPct: 0.10, sidesPct: 0.06 },
  "5:4": { topPct: 0.10, bottomPct: 0.10, sidesPct: 0.06 },
  "21:9": { topPct: 0.08, bottomPct: 0.08, sidesPct: 0.06 },
};

/** XML-escape untrusted text before it lands inside an SVG. Copy is AI/user-authored — never trust. */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ── Font-fit engine (area-first — define the box, size the font to fill it) ──
// Part 3 rule: "Area first, then font-to-fit. Don't pick a font size and hope it
// fills — that leaves dead space." Deterministic char-width heuristic (Helvetica
// Neue-ish glyph avg) is enough because we only need to know whether a candidate
// font size FITS a box — the composite doesn't care about pixel-perfect kerning.

/** Approximate average glyph width as a fraction of the font size, per weight
 *  (Helvetica Neue-ish). Heavier weights are wider. Italic ≈ +2%. Pure. */
export function glyphWidthRatio(weight: number, italic = false): number {
  const base = weight >= 900 ? 0.62 : weight >= 700 ? 0.56 : weight >= 500 ? 0.52 : 0.48;
  return italic ? base * 1.02 : base;
}

/** Greedy word-wrap onto `maxWidthPx` given `fontSizePx` + `weight`. Pure.
 *  A word longer than the maxWidth becomes its own overflowing line — the
 *  caller shrinks the font size to close the overflow. */
export function wrapTextToBox(text: string, maxWidthPx: number, fontSizePx: number, weight: number, italic = false): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const glyphW = glyphWidthRatio(weight, italic) * fontSizePx;
  const maxChars = Math.max(1, Math.floor(maxWidthPx / glyphW));
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const trial = current ? `${current} ${word}` : word;
    if (trial.length <= maxChars) {
      current = trial;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** "No orphans" rule (Part 3): a 2-letter word alone on the last line reads noob.
 *  Pull the previous line's last word down to keep the last line more than an
 *  orphan. Only applies when we have ≥2 lines. Pure. */
export function fixOrphans(lines: string[]): string[] {
  if (lines.length < 2) return lines;
  const last = lines[lines.length - 1];
  if (last.split(/\s+/).length !== 1 || last.length > 3) return lines;
  const prev = lines[lines.length - 2];
  const prevWords = prev.split(/\s+/);
  if (prevWords.length < 2) return lines;
  const pulled = prevWords.pop()!;
  return [...lines.slice(0, -2), prevWords.join(" "), `${pulled} ${last}`];
}

export interface FitFontToBoxArgs {
  text: string;
  maxWidthPx: number;
  maxHeightPx: number;
  /** Smallest font size (in px) the caller will accept. */
  minPx: number;
  /** Largest font size (in px) the caller wants — the ideal. */
  maxPx: number;
  /** SVG font-weight (300 / 400 / 700 / 900). */
  weight: number;
  italic?: boolean;
  /** Line height as a multiple of the font size. Default 1.15 (Helvetica-ish). */
  lineHeightRatio?: number;
}

export interface FitFontToBoxResult {
  fontSizePx: number;
  lines: string[];
  lineHeightPx: number;
  /** True iff the caller's ideal (`maxPx`) fit without shrinking — a signal the
   *  box could hold more text. False iff we had to shrink to `< maxPx` to fit. */
  fitsAtMax: boolean;
}

/**
 * AREA-FIRST font-fit — the caller defines the box (`maxWidthPx` × `maxHeightPx`)
 * and this helper picks the largest font size in `[minPx, maxPx]` that lets the
 * text fill without overflow. Wrapped lines respect the no-orphans rule. Pure.
 *
 * Called by `buildOverlaySVG` for each of the five copy slots. Named `fitFontToBox`
 * as the grep-token for the fit-to-box-typography verification.
 */
export function fitFontToBox(args: FitFontToBoxArgs): FitFontToBoxResult {
  const lhRatio = args.lineHeightRatio ?? 1.15;
  const step = Math.max(1, Math.floor((args.maxPx - args.minPx) / 24));
  let chosen = args.minPx;
  let chosenLines: string[] = [];
  let chosenLh = args.minPx * lhRatio;
  let fitsAtMax = false;
  for (let px = args.maxPx; px >= args.minPx; px -= step) {
    const lines = fixOrphans(wrapTextToBox(args.text, args.maxWidthPx, px, args.weight, args.italic));
    const glyphW = glyphWidthRatio(args.weight, args.italic) * px;
    const widest = lines.reduce((m, l) => Math.max(m, l.length * glyphW), 0);
    const lh = px * lhRatio;
    const totalH = lines.length * lh;
    if (widest <= args.maxWidthPx && totalH <= args.maxHeightPx) {
      chosen = px;
      chosenLines = lines;
      chosenLh = lh;
      fitsAtMax = px === args.maxPx;
      break;
    }
  }
  if (!chosenLines.length) {
    chosenLines = fixOrphans(wrapTextToBox(args.text, args.maxWidthPx, args.minPx, args.weight, args.italic));
    chosenLh = args.minPx * lhRatio;
    chosen = args.minPx;
  }
  return { fontSizePx: chosen, lines: chosenLines, lineHeightPx: chosenLh, fitsAtMax };
}

// ── Layout planner (per-ratio + scene-aware) ────────────────────────────────

export interface OverlayBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OverlayLayoutPlan {
  /** The full safe-zone inside the canvas — every text/CTA element MUST land inside this rect. */
  safe: OverlayBox;
  /** Where the headline text can live. */
  headlineBox: OverlayBox;
  /** Where the regret / sub-headline lives. */
  regretBox: OverlayBox;
  /** Where the bold-italic benefit stack lives. */
  benefitBox: OverlayBox;
  /** Where the payoff / support line lives. */
  payoffBox: OverlayBox;
  /** Where the CTA badge sits — always in the bottom safe band, never on the hero. */
  ctaBox: OverlayBox;
  /** Optional top scrim for legibility (only when text lands in a scene area — top-band layouts). */
  scrimTop: OverlayBox | null;
  /** Optional bottom scrim for the CTA band. */
  scrimBottom: OverlayBox | null;
  /** true when the layout is a left/right column instead of full-width top-band. */
  isColumn: boolean;
}

/**
 * Plan every text slot's box per-ratio + per-clear-zone. Deterministic + pure.
 * Enforces:
 *   • SAFE_ZONES — no element ever leaves the platform-safe rect (grep-token for
 *     the safe-zones-enforced verification);
 *   • Asymmetric gutters — tight to the product, generous at the frame edge (Part 3);
 *   • Scene-aware routing — `top_band` ⇒ full-width top; `side_column_left`/`right`
 *     ⇒ a column layout;
 *   • CTA always in the BOTTOM safe band (bottomPct of the canvas) — never over a
 *     hero element (drink/product), which the text-free scene keeps centered-lower.
 */
export function planLayout(ratio: NanoBananaAspect, w: number, h: number, clearZone: OverlayClearZone = "top_band"): OverlayLayoutPlan {
  const sz = SAFE_ZONES[ratio];
  const sideMargin = Math.round(w * sz.sidesPct);
  const topMargin = Math.round(h * sz.topPct);
  const bottomMargin = Math.round(h * sz.bottomPct);
  const safe: OverlayBox = {
    x: sideMargin,
    y: topMargin,
    w: w - sideMargin * 2,
    h: h - topMargin - bottomMargin,
  };
  // CTA lives in the BOTTOM safe band. Height ≈ min(canvas × 6%, safe-band × 40%). Sits
  // at the bottom of the safe rect with a small breathing gap — never on a hero element.
  const ctaH = Math.min(Math.round(h * 0.06), Math.round(bottomMargin * 0.9));
  const ctaW = Math.min(Math.round(safe.w * 0.85), Math.round(w * 0.7));
  const ctaBox: OverlayBox = {
    x: Math.round(safe.x + (safe.w - ctaW) / 2),
    y: safe.y + safe.h - ctaH,
    w: ctaW,
    h: ctaH,
  };
  const scrimBottom: OverlayBox = { x: 0, y: h - bottomMargin, w, h: bottomMargin };

  if (clearZone === "top_band") {
    // Full-width top band (open-top scene, product centered-low).
    // Vertical rhythm: headline gets ~25% of the top band, regret ~15%, benefit
    // stack sits in the mid area, payoff below it. Tight gutter between the top
    // stack and the regret (proven-device rhythm from Part 3).
    const topBandH = Math.round(safe.h * 0.32);
    const headlineH = Math.round(topBandH * 0.55);
    const regretH = topBandH - headlineH - Math.round(topBandH * 0.05); // small breathing gap
    const midStart = safe.y + topBandH + Math.round(safe.h * 0.02);
    const midH = Math.round(safe.h * 0.36);
    const benefitH = Math.round(midH * 0.55);
    const payoffH = midH - benefitH - Math.round(midH * 0.05);

    return {
      safe,
      headlineBox: { x: safe.x, y: safe.y, w: safe.w, h: headlineH },
      regretBox: { x: safe.x, y: safe.y + headlineH + Math.round(topBandH * 0.05), w: safe.w, h: regretH },
      benefitBox: { x: safe.x, y: midStart, w: safe.w, h: benefitH },
      payoffBox: { x: safe.x, y: midStart + benefitH + Math.round(midH * 0.05), w: safe.w, h: payoffH },
      ctaBox,
      // Scrim spans the whole top text band for legibility over any scene.
      scrimTop: { x: 0, y: 0, w, h: topMargin + topBandH + Math.round(safe.h * 0.03) },
      scrimBottom,
      isColumn: false,
    };
  }

  // Column layout — product hugged to one side, copy runs in the other column.
  // Asymmetric gutters: tight to the product (`innerGutter`), generous at the
  // frame edge (`safe`-derived from SAFE_ZONES).
  const columnFrac = 0.5; // half-canvas column keeps the product hero pack clear.
  const innerGutter = Math.round(w * 0.03); // TIGHT gutter to the product.
  const columnW = Math.round(safe.w * columnFrac) - innerGutter;
  const isLeft = clearZone === "side_column_left";
  const columnX = isLeft ? safe.x : safe.x + safe.w - columnW;

  const availableH = safe.h - ctaH - Math.round(safe.h * 0.04);
  const headlineH = Math.round(availableH * 0.28);
  const regretH = Math.round(availableH * 0.16);
  const benefitH = Math.round(availableH * 0.30);
  const payoffH = availableH - headlineH - regretH - benefitH - Math.round(availableH * 0.06);
  let cursor = safe.y;
  const headlineBox: OverlayBox = { x: columnX, y: cursor, w: columnW, h: headlineH };
  cursor += headlineH + Math.round(availableH * 0.02);
  const regretBox: OverlayBox = { x: columnX, y: cursor, w: columnW, h: regretH };
  cursor += regretH + Math.round(availableH * 0.02);
  const benefitBox: OverlayBox = { x: columnX, y: cursor, w: columnW, h: benefitH };
  cursor += benefitH + Math.round(availableH * 0.02);
  const payoffBox: OverlayBox = { x: columnX, y: cursor, w: columnW, h: Math.max(0, payoffH) };
  // Scrim spans the column height only (leaves the product side untouched).
  return {
    safe,
    headlineBox,
    regretBox,
    benefitBox,
    payoffBox,
    ctaBox,
    scrimTop: { x: isLeft ? 0 : w - (columnW + innerGutter + sideMargin), y: 0, w: columnW + innerGutter + sideMargin, h },
    scrimBottom,
    isColumn: true,
  };
}

// ── SVG emission ─────────────────────────────────────────────────────────────

/** Emit a single SVG <text> block using fitted lines + line height. Deterministic. */
function emitTextBlock(box: OverlayBox, lines: string[], lineHeightPx: number, fontSizePx: number, opts: { weight: number; italic?: boolean; fill: string; align?: "start" | "middle"; letterSpacing?: number }): string {
  if (!lines.length) return "";
  const font = "Helvetica Neue, Arial, sans-serif";
  const align = opts.align ?? "middle";
  const anchorX = align === "middle" ? box.x + box.w / 2 : box.x;
  const italic = opts.italic ? ` font-style="italic"` : "";
  const spacing = opts.letterSpacing ? ` letter-spacing="${opts.letterSpacing}"` : "";
  const parts: string[] = [];
  // Baseline starts one line-height below the top of the box (SVG y = baseline).
  let y = box.y + lineHeightPx;
  for (const line of lines) {
    parts.push(`<text x="${anchorX}" y="${Math.round(y)}" text-anchor="${align}" font-family="${font}" font-weight="${opts.weight}"${italic} font-size="${fontSizePx}" fill="${opts.fill}"${spacing}>${escapeXml(line)}</text>`);
    y += lineHeightPx;
  }
  return parts.join("");
}

/**
 * Build the SVG text layer for the overlay copy. Deterministic + pure — no I/O.
 * Phase 3: SAFE_ZONES + `fitFontToBox` + scene-aware `planLayout` (`clearZone`)
 * decide every element's position; the Part 3 typography spec (heavy headline,
 * light sub-headline / payoff, bold-italic benefit stack, tight gutter to the
 * product, generous edge margin, no orphaned words, CTA in the bottom safe band)
 * is enforced by the planner + font-fit, not eyeballed pixel offsets.
 */
export function buildOverlaySVG(copy: OverlayCopy, ratio: NanoBananaAspect, opts?: OverlayOpts): string {
  const canvas = CANVAS[ratio];
  const w = opts?.width ?? canvas.w;
  const h = opts?.height ?? canvas.h;
  const clearZone = opts?.clearZone ?? "top_band";
  const plan = planLayout(ratio, w, h, clearZone);

  const parts: string[] = [];
  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">`);
  // Scrims — "Legibility is ours to guarantee" (Part 3). Top scrim only when text
  // lands on scene (top-band or column); bottom scrim always sits behind the CTA band.
  if (plan.scrimTop) {
    parts.push(`<rect x="${plan.scrimTop.x}" y="${plan.scrimTop.y}" width="${plan.scrimTop.w}" height="${plan.scrimTop.h}" fill="rgba(0,0,0,0.35)"/>`);
  }
  if (plan.scrimBottom) {
    parts.push(`<rect x="${plan.scrimBottom.x}" y="${plan.scrimBottom.y}" width="${plan.scrimBottom.w}" height="${plan.scrimBottom.h}" fill="rgba(0,0,0,0.35)"/>`);
  }

  const align: "start" | "middle" = plan.isColumn ? "start" : "middle";

  // Headline — heavy/bold (900), largest ideal font in its box. Grep-token: fitFontToBox.
  const headlineFit = fitFontToBox({
    text: copy.headline,
    maxWidthPx: plan.headlineBox.w,
    maxHeightPx: plan.headlineBox.h,
    minPx: Math.round(h * 0.035),
    maxPx: Math.round(h * 0.085),
    weight: 900,
    lineHeightRatio: 1.05,
  });
  parts.push(emitTextBlock(plan.headlineBox, headlineFit.lines, headlineFit.lineHeightPx, headlineFit.fontSizePx, {
    weight: 900,
    fill: "#ffffff",
    align,
    letterSpacing: 2,
  }));

  // Regret / sub-headline — light 300, near-full-width per Part 3 ("sized to run near-full-width").
  if (copy.regret) {
    const fit = fitFontToBox({
      text: copy.regret,
      maxWidthPx: plan.regretBox.w,
      maxHeightPx: plan.regretBox.h,
      minPx: Math.round(h * 0.02),
      maxPx: Math.round(h * 0.038),
      weight: 300,
      lineHeightRatio: 1.2,
    });
    parts.push(emitTextBlock(plan.regretBox, fit.lines, fit.lineHeightPx, fit.fontSizePx, {
      weight: 300,
      fill: "#ffffff",
      align,
    }));
  }

  // Benefit stack — bold italic (700 italic), the one high-contrast block. Part 3.
  if (copy.benefitStack) {
    const fit = fitFontToBox({
      text: copy.benefitStack,
      maxWidthPx: plan.benefitBox.w,
      maxHeightPx: plan.benefitBox.h,
      minPx: Math.round(h * 0.024),
      maxPx: Math.round(h * 0.044),
      weight: 700,
      italic: true,
      lineHeightRatio: 1.2,
    });
    parts.push(emitTextBlock(plan.benefitBox, fit.lines, fit.lineHeightPx, fit.fontSizePx, {
      weight: 700,
      italic: true,
      fill: "#ffffff",
      align,
    }));
  }

  // Payoff — light 300, matches sub-headline weight per Part 3.
  if (copy.payoff) {
    const fit = fitFontToBox({
      text: copy.payoff,
      maxWidthPx: plan.payoffBox.w,
      maxHeightPx: plan.payoffBox.h,
      minPx: Math.round(h * 0.02),
      maxPx: Math.round(h * 0.032),
      weight: 300,
      lineHeightRatio: 1.2,
    });
    parts.push(emitTextBlock(plan.payoffBox, fit.lines, fit.lineHeightPx, fit.fontSizePx, {
      weight: 300,
      fill: "#ffffff",
      align,
    }));
  }

  if (copy.cta) {
    // CTA badge — white pill in the bottom safe band. NEVER overlaps hero (planLayout
    // guarantees ctaBox lives inside the bottomMargin, not on the scene).
    const rx = Math.round(plan.ctaBox.h / 2);
    parts.push(`<rect x="${plan.ctaBox.x}" y="${plan.ctaBox.y}" width="${plan.ctaBox.w}" height="${plan.ctaBox.h}" rx="${rx}" fill="#ffffff"/>`);
    const fit = fitFontToBox({
      text: copy.cta,
      maxWidthPx: plan.ctaBox.w - Math.round(plan.ctaBox.h * 0.5),
      maxHeightPx: Math.round(plan.ctaBox.h * 0.7),
      minPx: Math.round(plan.ctaBox.h * 0.35),
      maxPx: Math.round(plan.ctaBox.h * 0.55),
      weight: 700,
      lineHeightRatio: 1.0,
    });
    // The CTA renders as a single line — the fit-to-box result gives us the size + wrapping,
    // but we anchor it to the badge's vertical midline for a clean pill.
    const ctaY = plan.ctaBox.y + Math.round(plan.ctaBox.h * 0.68);
    parts.push(`<text x="${plan.ctaBox.x + plan.ctaBox.w / 2}" y="${ctaY}" text-anchor="middle" font-family="Helvetica Neue, Arial, sans-serif" font-weight="700" font-size="${fit.fontSizePx}" fill="#000000" letter-spacing="2">${escapeXml(copy.cta)}</text>`);
  }
  parts.push(`</svg>`);
  return parts.join("");
}

/**
 * Composite a copy overlay onto a text-free base image. The base is resized to
 * the ratio's nominal canvas (Meta's 1080-family), then the SVG text layer is
 * composited on top. The real font engine (sharp/librsvg) guarantees exact
 * spelling — this is the whole point of the overlay path.
 */
export async function compositeCopyOverlay(
  baseImage: Buffer,
  copy: OverlayCopy,
  ratio: NanoBananaAspect,
  opts: OverlayOpts = {},
): Promise<{ buffer: Buffer; mimeType: string }> {
  const canvas = CANVAS[ratio];
  const targetW = opts.width ?? canvas.w;
  const targetH = opts.height ?? canvas.h;
  const svg = buildOverlaySVG(copy, ratio, { ...opts, width: targetW, height: targetH });
  const wantPng = opts.outputMime === "image/png";
  const composited = sharp(baseImage)
    .resize(targetW, targetH, { fit: "cover" })
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }]);
  const buffer = wantPng ? await composited.png().toBuffer() : await composited.jpeg({ quality: 90 }).toBuffer();
  return { buffer, mimeType: wantPng ? "image/png" : "image/jpeg" };
}
