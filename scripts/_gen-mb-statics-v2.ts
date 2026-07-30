import { loadEnv } from "./_bootstrap";
loadEnv();
import sharp from "sharp";
import { writeFileSync } from "fs";
import { resolve } from "path";
import { generateNanoBananaProCombine, type NanoBananaAspect } from "../src/lib/gemini";

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const OUT = "/private/tmp/claude-501/-Users-admin-Projects-shopcx/c70e6ebd-556b-41d7-a1aa-17c4f938977d/scratchpad";

const COCOA =
  "https://urjbhjbygyxffrfkarqn.supabase.co/storage/v1/object/public/product-media/products/fdc11e10-b89f-4989-8b73-ed6526c4d906/ea433e56-0aa4-4b46-9107-feb11f77f533/variants/9ef9311d-57fa-426d-ad0f-250eaeabf122/isolated.png";
const HAZELNUT =
  "https://urjbhjbygyxffrfkarqn.supabase.co/storage/v1/object/public/product-media/products/fdc11e10-b89f-4989-8b73-ed6526c4d906/ea433e56-0aa4-4b46-9107-feb11f77f533/variants/9e2402f1-1821-4a20-ad57-e0c0901efc6b/isolated.png";

// Shared art-direction preamble — brand + audience + hard rules baked into every prompt.
const BRAND = `
ART DIRECTION — read carefully, follow exactly.
This is a FINISHED static ad for Meta (Facebook/Instagram) going LIVE with real budget. Premium, trustworthy, editorial quality.
AUDIENCE: women aged 50-65, mature, health-conscious, affluent. Calm and credible, NOT gen-z, NOT neon, NOT loud.
PALETTE: warm cream/off-white background (#f6efe4), deep forest green (#055c3f), warm terracotta accent (#ed886d), soft brown. Cozy morning-light mood.
TYPE: use a clean elegant serif for headlines and a clean sans for supporting text. LARGE, highly legible type with generous spacing — this audience needs big readable text. Perfect spelling and kerning. Real dictionary words only.
PRODUCT: the pouch shown in the reference image is the REAL "Amazing Coffee" superfood instant-coffee package — reproduce it faithfully and prominently (do NOT redraw its label text, keep it recognizable). It sits as the clear hero product.
COMPOSITION: leave clean, uncluttered space for the headline text away from the pouch. Balanced, airy, professional layout. A subtle steaming coffee cup or soft coffee beans / mushroom / turmeric accents are welcome but keep it clean.
HARD RULES: absolutely NO price anywhere — no dollar signs, no "$79.95", no numbers-as-price. No before/after imagery. No fake person or fabricated testimonial face. Do not invent any claims or words beyond the exact copy specified below. Every rendered letter must be spelled correctly.
`;

interface Concept {
  slug: string;
  image: string;
  copy: string;
}

const concepts: Concept[] = [
  {
    slug: "concept-1",
    image: COCOA,
    copy: `
LAYOUT — a "hook / promise / proof" ad. Render EXACTLY these text elements and NOTHING else textual:
1. Large serif HEADLINE, two lines, top third: "Sharper Focus." / "Fewer Cravings."
2. Smaller sans SUBHEAD directly under it: "The superfood coffee thousands switched to."
3. A row of five gold stars ★★★★★ with a short review quote in quotation marks: "Energy boost without jitters."
4. Three small rounded pill chips in a row, each with one word: "CHAGA"  "CORDYCEPS"  "TURMERIC"
5. A terracotta rounded offer badge (bottom): "FREE shipping + up to 34% off"
The Amazing Coffee pouch is the hero, lower-center/right. Warm, credible, premium.`,
  },
  {
    slug: "concept-2",
    image: HAZELNUT,
    copy: `
LAYOUT — a "problem → pivot → payoff" ad. Render EXACTLY these text elements and NOTHING else textual:
1. HOOK at top, serif, empathetic question: "Brain fog & afternoon cravings?"
2. PIVOT sentence, sans, middle: "Swap regular coffee for Amazing Coffee — with Chaga, Cordyceps & Turmeric."
3. PAYOFF line, bold, warm: "Sharper focus, fewer cravings, steady energy."
4. A terracotta rounded offer badge (bottom): "FREE shipping + up to 34% off"
The Amazing Coffee pouch is the hero product, clearly shown. Clean, airy, trustworthy layout.`,
  },
  {
    slug: "concept-3",
    image: COCOA,
    copy: `
LAYOUT — a "skeptic testimonial" ad, first-person voice, NO fabricated name or face (text only, no person). Render EXACTLY these text elements and NOTHING else textual:
1. Large serif opening quote, top: "Honestly? Mushroom coffee sounded ridiculous to me."
2. Second line beneath, warmer: "Then the fog lifted and the cravings faded."
3. Three small rounded pill chips in a row: "Chaga"  "Cordyceps"  "Turmeric"
4. A terracotta rounded offer badge (bottom): "FREE shipping + up to 34% off"
Editorial, honest, understated. The Amazing Coffee pouch shown clearly as the hero. No human figure, no invented testimonial identity.`,
  },
];

async function gen(concept: Concept, aspect: NanoBananaAspect, w: number, h: number, suffix: string) {
  const prompt = `${BRAND}\n${concept.copy}\n\nOutput a single finished ${aspect} vertical ad image, full-bleed, no borders or watermark.`;
  const { buffer } = await generateNanoBananaProCombine({
    workspaceId: WORKSPACE_ID,
    prompt,
    imageUrls: [concept.image],
    aspectRatio: aspect,
  });
  const outPath = resolve(OUT, `${concept.slug}-${suffix}.jpg`);
  await sharp(buffer).resize(w, h, { fit: "cover" }).jpeg({ quality: 92 }).toFile(outPath);
  const meta = await sharp(buffer).metadata();
  console.log(`  wrote ${outPath}  (model ${meta.width}x${meta.height} -> ${w}x${h})`);
  return outPath;
}

async function main() {
  const only = process.argv[2]; // optional: run just one concept slug
  const formats = (process.argv[3] || "both"); // "4x5" | "9x16" | "both"
  for (const c of concepts) {
    if (only && only !== c.slug) continue;
    console.log(`\n=== ${c.slug} ===`);
    try {
      if (formats === "4x5" || formats === "both") await gen(c, "4:5", 1080, 1350, "4x5");
    } catch (e) {
      console.error(`  4x5 FAILED: ${(e as Error).message}`);
    }
    try {
      if (formats === "9x16" || formats === "both") await gen(c, "9:16", 1080, 1920, "9x16");
    } catch (e) {
      console.error(`  9x16 FAILED: ${(e as Error).message}`);
    }
  }
  console.log("\nDONE");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
