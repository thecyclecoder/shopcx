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
 * Phase 1 (this file) wires a correct, functional compositor — headline on top,
 * regret sub-headline, benefit stack (bold italic) mid, payoff, CTA badge
 * bottom, with scrims for legibility. Phase 3 upgrades this with per-ratio
 * safe zones + fit-to-box typography + scene-aware clear-zone routing.
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

export interface OverlayOpts {
  /** Output encoding — jpeg (default) or png. */
  outputMime?: "image/jpeg" | "image/png";
  /** Override the default canvas size derived from `ratio`. */
  width?: number;
  height?: number;
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

/** XML-escape untrusted text before it lands inside an SVG. Copy is AI/user-authored — never trust. */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Build the SVG text layer for the overlay copy. Deterministic + pure — no I/O.
 * Phase 1 wires a correct, functional layout; Phase 3 upgrades with safe zones
 * + fit-to-box typography + scene-aware clear-zone routing (per ratio).
 */
export function buildOverlaySVG(copy: OverlayCopy, ratio: NanoBananaAspect, opts?: OverlayOpts): string {
  const canvas = CANVAS[ratio];
  const w = opts?.width ?? canvas.w;
  const h = opts?.height ?? canvas.h;

  const paddingTop = Math.round(h * 0.06);
  const paddingBottom = Math.round(h * 0.08);
  const headlineY = paddingTop + Math.round(h * 0.05);
  const regretY = headlineY + Math.round(h * 0.09);
  const benefitY = Math.round(h * 0.55);
  const payoffY = benefitY + Math.round(h * 0.12);
  const ctaY = h - paddingBottom - Math.round(h * 0.03);

  const headlineSize = Math.round(h * 0.075);
  const regretSize = Math.round(h * 0.032);
  const benefitSize = Math.round(h * 0.038);
  const payoffSize = Math.round(h * 0.028);
  const ctaSize = Math.round(h * 0.032);

  const scrimTopH = Math.round(h * 0.28);
  const scrimBottomH = Math.round(h * 0.14);

  const parts: string[] = [];
  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">`);
  // Scrims behind the copy zones — "Legibility is ours to guarantee" (Part 3 rule).
  parts.push(`<rect x="0" y="0" width="${w}" height="${scrimTopH}" fill="rgba(0,0,0,0.35)"/>`);
  parts.push(`<rect x="0" y="${h - scrimBottomH}" width="${w}" height="${scrimBottomH}" fill="rgba(0,0,0,0.35)"/>`);

  const font = "Helvetica Neue, Arial, sans-serif";
  // Headline — heavy/bold, top, centered.
  parts.push(`<text x="${w / 2}" y="${headlineY}" text-anchor="middle" font-family="${font}" font-weight="900" font-size="${headlineSize}" fill="#ffffff" letter-spacing="2">${escapeXml(copy.headline)}</text>`);
  if (copy.regret) {
    parts.push(`<text x="${w / 2}" y="${regretY}" text-anchor="middle" font-family="${font}" font-weight="300" font-size="${regretSize}" fill="#ffffff">${escapeXml(copy.regret)}</text>`);
  }
  if (copy.benefitStack) {
    parts.push(`<text x="${w / 2}" y="${benefitY}" text-anchor="middle" font-family="${font}" font-weight="700" font-style="italic" font-size="${benefitSize}" fill="#ffffff">${escapeXml(copy.benefitStack)}</text>`);
  }
  if (copy.payoff) {
    parts.push(`<text x="${w / 2}" y="${payoffY}" text-anchor="middle" font-family="${font}" font-weight="300" font-size="${payoffSize}" fill="#ffffff">${escapeXml(copy.payoff)}</text>`);
  }
  if (copy.cta) {
    // CTA badge — rounded rect + centered label. White pill on dark scrim.
    const badgeW = Math.round(w * 0.6);
    const badgeH = Math.round(h * 0.06);
    const badgeX = Math.round((w - badgeW) / 2);
    const badgeY = ctaY - Math.round(badgeH * 0.75);
    parts.push(`<rect x="${badgeX}" y="${badgeY}" width="${badgeW}" height="${badgeH}" rx="${Math.round(badgeH / 2)}" fill="#ffffff"/>`);
    parts.push(`<text x="${w / 2}" y="${ctaY}" text-anchor="middle" font-family="${font}" font-weight="700" font-size="${ctaSize}" fill="#000000" letter-spacing="2">${escapeXml(copy.cta)}</text>`);
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
