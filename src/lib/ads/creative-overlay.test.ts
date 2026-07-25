/**
 * Unit tests for the font-engine copy compositor (dahlia-competitor-ad-adaptation-overlay-render
 * Phase 1). The whole point of the overlay path is that spelling is EXACT by construction — a real
 * font engine, not a diffusion model. So the tests pin the deterministic surface: the SVG carries
 * the copy strings verbatim (with XML escaping), and the sharp composite returns a valid image
 * whose bytes changed from the untouched base (proving the overlay actually landed).
 *
 * Run: npx tsx --test src/lib/ads/creative-overlay.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { buildOverlaySVG, compositeCopyOverlay, escapeXml, type OverlayCopy } from "./creative-overlay";

async function makeSolidJpeg(w = 256, h = 320): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 20, g: 30, b: 40 } } }).jpeg().toBuffer();
}

test("escapeXml: escapes ampersand, angle brackets, and quotes so copy is safe inside SVG", () => {
  assert.equal(escapeXml("A & B < C > D \"E\" 'F'"), "A &amp; B &lt; C &gt; D &quot;E&quot; &apos;F&apos;");
});

test("buildOverlaySVG: renders headline verbatim at the top and includes optional slots when supplied", () => {
  const copy: OverlayCopy = {
    headline: "SORRY IN ADVANCE",
    regret: "We regret to inform you that your skincare shelf might shrink.",
    benefitStack: "smooth skin, thicken hair, curb cravings, reduce bloating",
    payoff: "We take full responsibility for the double-takes.",
    cta: "TRY IT RISK-FREE",
  };
  const svg = buildOverlaySVG(copy, "4:5");
  assert.match(svg, /^<\?xml/, "starts with an XML prolog");
  assert.match(svg, /<svg /, "renders an SVG root");
  assert.ok(svg.includes("SORRY IN ADVANCE"), "headline present verbatim");
  assert.ok(svg.includes("We regret to inform you"), "regret sub-headline present");
  assert.ok(svg.includes("smooth skin, thicken hair"), "benefit stack present");
  assert.ok(svg.includes("We take full responsibility"), "payoff present");
  assert.ok(svg.includes("TRY IT RISK-FREE"), "CTA present");
  assert.match(svg, /font-weight="900"/, "headline uses heavy weight");
  assert.match(svg, /font-style="italic"/, "benefit stack uses bold italic");
});

test("buildOverlaySVG: XML-escapes ampersands in copy (never emits raw `&` inside a text node)", () => {
  const copy: OverlayCopy = { headline: "SORRY & THANKS" };
  const svg = buildOverlaySVG(copy, "4:5");
  assert.ok(svg.includes("SORRY &amp; THANKS"), "raw ampersand becomes &amp;");
  assert.ok(!/>SORRY & THANKS</.test(svg), "no raw ampersand survives inside a text node");
});

test("buildOverlaySVG: omits optional slots when not supplied (only headline renders)", () => {
  const svg = buildOverlaySVG({ headline: "HELLO" }, "9:16");
  assert.ok(svg.includes("HELLO"));
  // No CTA badge rect (white pill) means no `fill="#ffffff"` on a <rect>. Scrims are the only rects,
  // and they use rgba fills — so the presence of ONLY rgba-filled rects proves the CTA badge is absent.
  assert.ok(!/<rect [^>]*fill="#ffffff"/.test(svg), "no CTA badge rendered when copy.cta is absent");
});

test("buildOverlaySVG: honours the ratio's canvas size (4:5 vs 9:16 differ)", () => {
  const svg45 = buildOverlaySVG({ headline: "X" }, "4:5");
  const svg916 = buildOverlaySVG({ headline: "X" }, "9:16");
  assert.match(svg45, /viewBox="0 0 1080 1350"/);
  assert.match(svg916, /viewBox="0 0 1080 1920"/);
});

test("compositeCopyOverlay: returns a valid JPEG that differs from the untouched base (overlay landed)", async () => {
  const base = await makeSolidJpeg();
  const { buffer, mimeType } = await compositeCopyOverlay(base, { headline: "SORRY IN ADVANCE", cta: "TRY IT RISK-FREE" }, "4:5");
  assert.equal(mimeType, "image/jpeg");
  const meta = await sharp(buffer).metadata();
  assert.equal(meta.format, "jpeg");
  assert.equal(meta.width, 1080);
  assert.equal(meta.height, 1350);
  // Bytes must differ from a plain resize of the base (the overlay actually composited).
  const plainResize = await sharp(base).resize(1080, 1350, { fit: "cover" }).jpeg({ quality: 90 }).toBuffer();
  assert.notEqual(buffer.length, plainResize.length, "composited output should differ from the untouched resized base");
});

test("compositeCopyOverlay: png output honours outputMime option", async () => {
  const base = await makeSolidJpeg();
  const { buffer, mimeType } = await compositeCopyOverlay(base, { headline: "PNG" }, "1:1", { outputMime: "image/png" });
  assert.equal(mimeType, "image/png");
  const meta = await sharp(buffer).metadata();
  assert.equal(meta.format, "png");
  assert.equal(meta.width, 1080);
  assert.equal(meta.height, 1080);
});
