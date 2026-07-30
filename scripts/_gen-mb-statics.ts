/**
 * Throwaway: generate finished static Meta ads for "Amazing Coffee" via Nano Banana Pro.
 * Usage:
 *   npx tsx scripts/_gen-mb-statics.ts <concept 1|2|3> <aspect 4x5|9x16> [attemptTag]
 *   npx tsx scripts/_gen-mb-statics.ts all 4x5
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { writeFileSync } from "fs";
import { resolve } from "path";
import { generateNanoBananaProCombine, type NanoBananaAspect } from "../src/lib/gemini";

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const OUT = "/private/tmp/claude-501/-Users-admin-Projects-shopcx/c70e6ebd-556b-41d7-a1aa-17c4f938977d/scratchpad";

const COCOA =
  "https://urjbhjbygyxffrfkarqn.supabase.co/storage/v1/object/public/product-media/products/fdc11e10-b89f-4989-8b73-ed6526c4d906/ea433e56-0aa4-4b46-9107-feb11f77f533/variants/9ef9311d-57fa-426d-ad0f-250eaeabf122/isolated.png";
const HAZELNUT =
  "https://urjbhjbygyxffrfkarqn.supabase.co/storage/v1/object/public/product-media/products/fdc11e10-b89f-4989-8b73-ed6526c4d906/ea433e56-0aa4-4b46-9107-feb11f77f533/variants/9e2402f1-1821-4a20-ad57-e0c0901efc6b/isolated.png";

// Shared art direction appended to every concept prompt.
const SHARED = `
ART DIRECTION (follow exactly):
- This is a premium direct-response advertisement for a superfood coffee brand, aimed at health-conscious women aged 50 to 65. It must read as trustworthy, warm, calm and credible — NOT a tech startup, NOT gen-z, NO neon, NO glowing gradients, NO dark cyberpunk look.
- Brand palette: deep forest green #055c3f and a warm terracotta/peach accent #ed886d, on a clean warm cream/off-white background. Plenty of soft, airy negative space.
- The product package shown in the reference image must be reproduced FAITHFULLY and remain the clear hero of the ad: keep its real "AMAZING COFFEE" label, orange-and-white stand-up pouch, and coffee-cup artwork exactly as in the reference. Do NOT redesign the package, do NOT change its wording, do NOT warp it. Place it upright, well-lit, large.
- TYPOGRAPHY IS CRITICAL: every letter of every word must be rendered PERFECTLY and spelled EXACTLY as written below — no gibberish, no invented words, no doubled or dropped letters. Use a clean, elegant, high-legibility typeface (a refined serif for headlines, a clean sans for small text) at LARGE size with strong contrast so a 60-year-old can read it easily. Prefer fewer words rendered flawlessly over cramming text.
- Include a clear offer badge with the EXACT text: "FREE shipping + up to 34% off". Render the price "$79.95".
- Composition safe for Meta feed: keep all text within the central area, no text touching the edges.
`.trim();

type Concept = { id: string; product: string; prompt: string };

const CONCEPTS: Concept[] = [
  {
    id: "concept-1",
    product: COCOA,
    prompt: `Create a clean premium 4:5 direct-response ad for "Amazing Coffee", a superfood coffee.
Layout top to bottom:
- HEADLINE (largest, deep green #055c3f serif): "All-Day Energy. Zero Jitters."
- Subhead (smaller, warm gray): "The superfood coffee thousands switched to."
- The product pouch (from the reference image) shown large and upright, center.
- A row of five gold five-star icons, and directly beneath them a short customer quote in quotation marks: "Energy boost without jitters."
- An ingredient callout line in small clean caps: "CHAGA  ·  CORDYCEPS  ·  TURMERIC".
- A rounded offer badge in terracotta #ed886d with white text: "FREE shipping + up to 34% off", and the price "$79.95" nearby.
${SHARED}`,
  },
  {
    id: "concept-2",
    product: HAZELNUT,
    prompt: `Create a clean premium 4:5 direct-response ad for "Amazing Coffee", a superfood coffee.
Layout top to bottom:
- PROBLEM HOOK headline (large, deep green #055c3f serif): "Hit an afternoon crash again?"
- Pivot line (medium, warm gray): "Swap regular coffee for Amazing Coffee — with Chaga, Cordyceps & Turmeric."
- The product pouch (from the reference image) shown large and upright, center, beside a warm cup of coffee.
- Payoff line (medium, deep green, confident): "Steady focus and clean energy, all day."
- A rounded offer badge in terracotta #ed886d with white text: "FREE shipping + up to 34% off", and the price "$79.95" nearby.
${SHARED}`,
  },
  {
    id: "concept-3",
    product: COCOA,
    prompt: `Create a clean premium 4:5 direct-response ad for "Amazing Coffee", a superfood coffee. Warm, believable, testimonial-style — but with NO fake person's name and NO fake face; use honest first-person ad copy only as set text.
Layout top to bottom:
- Opening line in quotation marks (large, deep green #055c3f serif), reads like an honest confession: "Honestly? Mushroom coffee sounded ridiculous to me."
- Turn line beneath it (medium, warm terracotta #ed886d): "Then I felt the difference — real focus, no crash."
- The product pouch (from the reference image) shown large and upright, center.
- A small trust line under the product: "Chaga · Cordyceps · Turmeric".
- A rounded offer badge in terracotta #ed886d with white text: "FREE shipping + up to 34% off", and the price "$79.95" nearby.
${SHARED}`,
  },
];

const ASPECTS: Record<string, NanoBananaAspect> = { "4x5": "4:5", "9x16": "9:16" };

async function genOne(c: Concept, aspectKey: string, tag: string) {
  const aspectRatio = ASPECTS[aspectKey];
  const prompt = aspectKey === "9x16" ? c.prompt.replace(/\b4:5\b/g, "9:16 (tall vertical Stories/Reels)") : c.prompt;
  process.stdout.write(`\n[gen] ${c.id} ${aspectKey}${tag ? " " + tag : ""} … `);
  const { buffer, mimeType } = await generateNanoBananaProCombine({
    workspaceId: WORKSPACE_ID,
    prompt,
    imageUrls: [c.product],
    aspectRatio,
  });
  const ext = mimeType.includes("png") ? "png" : "jpg";
  const name = `${c.id}-${aspectKey}${tag ? "-" + tag : ""}.${ext}`;
  const path = resolve(OUT, name);
  writeFileSync(path, buffer);
  process.stdout.write(`saved ${path} (${buffer.length} bytes, ${mimeType})`);
  return path;
}

async function main() {
  const [which = "all", aspectKey = "4x5", tag = ""] = process.argv.slice(2);
  const targets = which === "all" ? CONCEPTS : CONCEPTS.filter((c) => c.id.endsWith(which));
  if (!targets.length) throw new Error(`no concept matched "${which}"`);
  if (!ASPECTS[aspectKey]) throw new Error(`bad aspect "${aspectKey}" (use 4x5|9x16)`);
  for (const c of targets) {
    try {
      await genOne(c, aspectKey, tag);
    } catch (e) {
      process.stdout.write(`\n[ERROR] ${c.id}: ${(e as Error).message}`);
    }
  }
  process.stdout.write("\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
