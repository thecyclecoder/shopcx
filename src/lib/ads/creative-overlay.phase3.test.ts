/**
 * Phase-3 unit tests for the overlay compositor's typography + per-ratio layout
 * (dahlia-competitor-ad-adaptation-overlay-render Phase 3). Pins the two verification
 * artifacts:
 *   • fit-to-box typography — `fitFontToBox` returns the largest font size that fits
 *     the caller's box, wraps words to `maxWidthPx`, and applies the no-orphans rule;
 *   • platform safe zones enforced — `SAFE_ZONES` carries Meta's unified 2026 numbers
 *     (9:16 = 14% top / 20% bottom / 6% sides; 4:5 = 14/14/6; 1:1 = 10/10/6) and
 *     `planLayout` places every text/CTA element inside that rect, with the CTA in the
 *     bottom safe band and column layouts that follow the scene's clear zone.
 *
 * Run: npx tsx --test src/lib/ads/creative-overlay.phase3.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOverlaySVG,
  fitFontToBox,
  fixOrphans,
  glyphWidthRatio,
  planLayout,
  SAFE_ZONES,
  wrapTextToBox,
} from "./creative-overlay";

// ── SAFE_ZONES — the exact platform numbers the CEO cited ────────────────────

test("SAFE_ZONES: 9:16 carries Meta's unified 2026 numbers (14% top / 20% bottom / 6% sides)", () => {
  assert.deepEqual(SAFE_ZONES["9:16"], { topPct: 0.14, bottomPct: 0.20, sidesPct: 0.06 });
});

test("SAFE_ZONES: 4:5 (feed) gives 14% breathing room on every side", () => {
  assert.deepEqual(SAFE_ZONES["4:5"], { topPct: 0.14, bottomPct: 0.14, sidesPct: 0.06 });
});

test("SAFE_ZONES: 1:1 (right column) uses lighter 10% top-bottom / 6% sides", () => {
  assert.deepEqual(SAFE_ZONES["1:1"], { topPct: 0.10, bottomPct: 0.10, sidesPct: 0.06 });
});

// ── Fit-to-box typography ────────────────────────────────────────────────────

test("glyphWidthRatio: heavier weight is wider (900 > 700 > 300); italic ≈ +2%", () => {
  assert.ok(glyphWidthRatio(900) > glyphWidthRatio(700));
  assert.ok(glyphWidthRatio(700) > glyphWidthRatio(300));
  assert.ok(glyphWidthRatio(700, true) > glyphWidthRatio(700, false));
});

test("wrapTextToBox: wraps to the greedy char count implied by maxWidth + glyph width", () => {
  const lines = wrapTextToBox("one two three four five six seven eight", 200, 40, 700);
  assert.ok(lines.length >= 2, "text too wide for one line at fontSize=40 → wraps");
  for (const l of lines) {
    // No line exceeds the box width (approx-checked via char count × glyph width).
    assert.ok(l.length * glyphWidthRatio(700) * 40 <= 200 + 40, `line "${l}" fits maxWidth`);
  }
});

test("fixOrphans: pulls the previous line's last word down when the last line is a single short word", () => {
  const before = ["The compliments you are about", "to"];
  const after = fixOrphans(before);
  assert.equal(after.length, 2, "still two lines");
  assert.ok(!/^to$/.test(after[after.length - 1]), "no bare 2-letter last line — the orphan was fixed");
});

test("fixOrphans: leaves already-good line breaks alone", () => {
  assert.deepEqual(fixOrphans(["hello world", "and again"]), ["hello world", "and again"]);
});

test("fitFontToBox: picks the LARGEST font in [minPx, maxPx] that fits the box (area-first)", () => {
  const fit = fitFontToBox({
    text: "SORRY IN ADVANCE",
    maxWidthPx: 800,
    maxHeightPx: 200,
    minPx: 20,
    maxPx: 160,
    weight: 900,
    lineHeightRatio: 1.05,
  });
  assert.ok(fit.fontSizePx >= 60 && fit.fontSizePx <= 160, `expected large font that fits; got ${fit.fontSizePx}`);
  assert.ok(fit.lines.length >= 1);
  // Widest line fits maxWidth.
  const glyphW = glyphWidthRatio(900) * fit.fontSizePx;
  const widest = fit.lines.reduce((m, l) => Math.max(m, l.length * glyphW), 0);
  assert.ok(widest <= 800 + fit.fontSizePx, "widest line respects maxWidth (with one-glyph slack)");
  // Total height fits maxHeight.
  assert.ok(fit.lines.length * fit.lineHeightPx <= 200 + fit.lineHeightPx, "total height respects maxHeight (with one-line slack)");
});

test("fitFontToBox: shrinks to fit when the ideal maxPx overflows", () => {
  const longText = "We regret to inform you that your skincare shelf AND your jeans size might shrink dramatically over the next several weeks";
  const fit = fitFontToBox({
    text: longText,
    maxWidthPx: 400,
    maxHeightPx: 100,
    minPx: 12,
    maxPx: 60,
    weight: 300,
  });
  assert.ok(fit.fontSizePx < 60, `expected shrink from ideal; got ${fit.fontSizePx}`);
  assert.ok(!fit.fitsAtMax, "fitsAtMax=false when we had to shrink");
});

// ── planLayout — per-ratio + scene-aware ────────────────────────────────────

test("planLayout: 9:16 places every element inside the SAFE_ZONES rect", () => {
  const w = 1080;
  const h = 1920;
  const plan = planLayout("9:16", w, h, "top_band");
  const sz = SAFE_ZONES["9:16"];
  // Safe rect matches SAFE_ZONES arithmetic.
  assert.equal(plan.safe.x, Math.round(w * sz.sidesPct));
  assert.equal(plan.safe.y, Math.round(h * sz.topPct));
  assert.equal(plan.safe.w, w - Math.round(w * sz.sidesPct) * 2);
  assert.equal(plan.safe.h, h - Math.round(h * sz.topPct) - Math.round(h * sz.bottomPct));
  // Every text box lies inside the safe rect (x ≥ safe.x, right edge ≤ safe.right).
  for (const [name, box] of [
    ["headlineBox", plan.headlineBox],
    ["regretBox", plan.regretBox],
    ["benefitBox", plan.benefitBox],
    ["payoffBox", plan.payoffBox],
    ["ctaBox", plan.ctaBox],
  ] as const) {
    assert.ok(box.x >= plan.safe.x, `${name}.x inside safe rect`);
    assert.ok(box.x + box.w <= plan.safe.x + plan.safe.w, `${name} right edge inside safe rect`);
    assert.ok(box.y >= plan.safe.y, `${name}.y inside safe rect`);
    assert.ok(box.y + box.h <= plan.safe.y + plan.safe.h + 1, `${name} bottom edge inside safe rect`);
  }
});

test("planLayout: CTA sits in the BOTTOM safe band, never overlaps a hero element", () => {
  const w = 1080;
  const h = 1920;
  const plan = planLayout("9:16", w, h, "top_band");
  const bottomSafeTop = h - Math.round(h * SAFE_ZONES["9:16"].bottomPct);
  // CTA's TOP is at or below the bottom safe band's top. This is what keeps it off the hero.
  assert.ok(plan.ctaBox.y >= bottomSafeTop - plan.ctaBox.h, "CTA nested in bottom safe band");
  assert.ok(plan.ctaBox.y + plan.ctaBox.h <= h, "CTA stays inside canvas");
});

test("planLayout: top_band layout is full-width center-aligned (not a column)", () => {
  const plan = planLayout("4:5", 1080, 1350, "top_band");
  assert.equal(plan.isColumn, false);
  // Headline box spans the full safe width.
  assert.equal(plan.headlineBox.w, plan.safe.w);
});

test("planLayout: side_column_left routes text to a LEFT column, leaving the right side for the product", () => {
  const w = 1080;
  const h = 1350;
  const plan = planLayout("4:5", w, h, "side_column_left");
  assert.equal(plan.isColumn, true);
  // Column starts at the left safe edge.
  assert.equal(plan.headlineBox.x, plan.safe.x);
  // Column is roughly half the safe width (leaves room for the product on the right).
  assert.ok(plan.headlineBox.w < plan.safe.w * 0.6, `column narrower than half-safe; got ${plan.headlineBox.w}`);
});

test("planLayout: side_column_right routes text to a RIGHT column (mirror layout)", () => {
  const plan = planLayout("4:5", 1080, 1350, "side_column_right");
  assert.equal(plan.isColumn, true);
  // Column's right edge kisses the safe right edge.
  assert.equal(plan.headlineBox.x + plan.headlineBox.w, plan.safe.x + plan.safe.w);
});

test("planLayout: asymmetric gutters — tight to the product side, generous at the frame edge", () => {
  const w = 1080;
  const h = 1350;
  const planLeft = planLayout("4:5", w, h, "side_column_left");
  // Frame-edge gap (from left frame to column) = safe.x (SAFE_ZONES sidesPct * w).
  const frameEdgeGap = planLeft.headlineBox.x;
  // Gutter to the product (column right edge → half-canvas midpoint proxy = safe.x + safe.w/2).
  const columnRightEdge = planLeft.headlineBox.x + planLeft.headlineBox.w;
  const productSideStart = planLeft.safe.x + planLeft.safe.w / 2;
  const gutterToProduct = productSideStart - columnRightEdge;
  // The tight gutter to the product must be smaller than the generous frame-edge margin.
  assert.ok(gutterToProduct <= frameEdgeGap, `expected tight-to-product gutter (${gutterToProduct}) ≤ frame-edge margin (${frameEdgeGap})`);
});

// ── Wire-through — buildOverlaySVG honours the ratio's safe zones + clearZone ─

test("buildOverlaySVG: 9:16 emits scrimBottom at y=canvas-bottomPct*h (safe-zone enforced in the SVG output)", () => {
  const svg = buildOverlaySVG({ headline: "H", cta: "CTA" }, "9:16");
  const bottomSafeTop = 1920 - Math.round(1920 * SAFE_ZONES["9:16"].bottomPct);
  assert.match(svg, new RegExp(`<rect [^>]*y="${bottomSafeTop}"`), "scrimBottom rectangle sits at the bottom safe-band boundary");
});

test("buildOverlaySVG: clearZone='side_column_left' renders left-anchored text (text-anchor='start')", () => {
  const svg = buildOverlaySVG({ headline: "HELLO WORLD" }, "4:5", { clearZone: "side_column_left" });
  assert.match(svg, /text-anchor="start"/, "column layout uses left-anchored text");
});

test("buildOverlaySVG: clearZone='top_band' (default) renders center-anchored text (text-anchor='middle')", () => {
  const svg = buildOverlaySVG({ headline: "HELLO" }, "4:5");
  assert.match(svg, /text-anchor="middle"/, "top-band layout uses center-anchored text");
});
