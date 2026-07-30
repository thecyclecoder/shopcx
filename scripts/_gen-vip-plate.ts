/**
 * Stage 1 of the VIP-weekend graphic: generate the BACKGROUND PLATE only
 * (backdrop + headline lockup, empty product stage) via Nano Banana Pro.
 *
 * No packshots are passed in — the model reinvents packaging when it is asked
 * to fuse six references, so the real cut-outs are composited deterministically
 * in stage 2 (`_composite-vip-graphic.ts`) instead.
 *
 * Calls `:generateContent` directly (rather than `generateNanoBananaProCombine`)
 * only to set `imageConfig.imageSize = "2K"`, which the shared helper doesn't
 * expose. Read-only against the DB; writes plates to the scratchpad.
 */
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import "./_bootstrap";
import { getGeminiCredentials, NANO_BANANA_PRO_MODEL } from "../src/lib/gemini";

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const OUT_DIR = join(
  "/private/tmp/claude-501/-Users-admin-Projects-shopcx/a9611f01-5e57-4883-8da5-a8ffb20aa4e9/scratchpad",
  "plates",
);

const RULES = `
HARD RULES:
- This is a BACKGROUND PLATE. Render NO products, NO packages, NO pouches, NO bottles, NO jars, NO boxes, NO food, NO drinks, NO people, NO hands.
- The entire lower 55% of the square must stay an empty, clean, uncluttered surface with nothing standing on it. Product cut-outs will be composited there later.
- The ONLY text in the image is the two-line headline specified below. No other words, no taglines, no logos, no website, no dates.
- ABSOLUTELY NO numbers, percentages, prices, dollar signs, "% OFF" or "SAVE" anywhere. This plate must be reusable for any future sale.
- Headline lettering must be perfectly spelled, sharply rendered and professionally kerned.
- Square 1:1, high-resolution, clean commercial finish.
`.trim();

const PLATES: { slug: string; prompt: string }[] = [
  {
    slug: "plate-black-gold",
    prompt: `A luxurious, empty 1:1 square studio background plate for a premium VIP sale announcement.

BACKDROP: Deep charcoal-to-near-black vertical gradient. A warm golden glow radiates softly from the horizon line behind the middle of the frame, falling off into darkness at the corners. A few elegant, sparse gold light streaks arc across the upper background. Very fine, sparse floating gold dust particles, tasteful and restrained.

SURFACE: The lower 55% of the frame is a glossy black reflective tabletop, completely empty, meeting the backdrop at a soft glowing horizon line. Nothing sits on it.

HEADLINE: In the upper third, centered, set "VIP WEEKEND" as a large bold wide uppercase condensed sans-serif with a brushed metallic gold finish, and directly beneath it the single word "SALE" in a smaller widely letter-spaced uppercase gold serif. Leave generous empty space below the headline.

MOOD: exclusive, members-only, expensive.

${RULES}`,
  },
  {
    slug: "plate-cream-editorial",
    prompt: `A clean, modern, editorial 1:1 square studio background plate for a premium wellness-brand VIP sale announcement.

BACKDROP: Soft warm cream / off-white seamless studio backdrop with a gentle warm radial glow in the centre. Behind the centre of the frame sits one large flat circle of soft muted terracotta, like a modern editorial backdrop shape, its lower half hidden behind the surface line. A thin elegant gold hairline border is inset from the edge of the square frame.

SURFACE: The lower 55% of the frame is a matte cream tabletop, completely empty, softly lit from the upper left. Nothing sits on it.

HEADLINE: In the upper third, centered, set "VIP WEEKEND" in a large bold uppercase sans-serif in deep charcoal, and directly beneath it the single word "SALE" in a smaller widely letter-spaced uppercase in warm gold. Leave generous empty space below the headline.

MOOD: clean, premium, calm, aspirational.

${RULES}`,
  },
  {
    slug: "plate-warm-spotlight",
    prompt: `A bold, high-impact 1:1 square studio background plate for a premium VIP sale announcement.

BACKDROP: Rich burnt-orange to deep amber vertical gradient, with a bright soft circular spotlight pool glowing in the centre behind the frame and a warm dark vignette in the corners. A soft glowing halo ring of light sits in the middle of the frame. Subtle warm lens bloom.

SURFACE: The lower 55% of the frame is a subtly reflective warm amber tabletop, completely empty, lit from above front. Nothing sits on it.

HEADLINE: In the upper third, centered, set "VIP WEEKEND" in a very bold heavy uppercase condensed sans-serif in clean white, and directly beneath it the single word "SALE" in a smaller widely letter-spaced uppercase in soft cream. Leave generous empty space below the headline.

MOOD: energetic, urgent, scroll-stopping.

${RULES}`,
  },
];

const BASE = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta";

async function generatePlate(apiKey: string, prompt: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ["IMAGE"],
      imageConfig: { aspectRatio: "1:1", imageSize: "2K" },
    },
  };
  const res = await fetch(`${BASE}/models/${NANO_BANANA_PRO_MODEL}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`gemini_${res.status}:${(json?.error?.message || "").slice(0, 200)}`);
  const parts = json?.candidates?.[0]?.content?.parts || [];
  const img = parts.find((p: any) => p.inline_data || p.inlineData);
  if (!img) throw new Error("gemini_no_image");
  const inline = img.inline_data || img.inlineData;
  return {
    buffer: Buffer.from(inline.data, "base64"),
    mimeType: inline.mime_type || inline.mimeType || "image/png",
  };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const creds = await getGeminiCredentials(WORKSPACE_ID);
  if (!creds) throw new Error("gemini_not_connected");

  const only = process.argv[2];
  const targets = only ? PLATES.filter((p) => p.slug === only) : PLATES;
  if (!targets.length) throw new Error(`no plate matching "${only}"`);

  for (const p of targets) {
    process.stdout.write(`plate ${p.slug} … `);
    try {
      const { buffer, mimeType } = await generatePlate(creds.apiKey, p.prompt);
      const ext = mimeType.includes("jpeg") ? "jpg" : "png";
      const path = join(OUT_DIR, `${p.slug}.${ext}`);
      writeFileSync(path, buffer);
      console.log(`ok → ${path} (${(buffer.length / 1024).toFixed(0)} KB)`);
    } catch (e) {
      console.log(`FAILED: ${(e as Error).message}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
