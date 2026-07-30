import { loadEnv } from "./_bootstrap";
loadEnv();
import { generateNanoBananaProCombine } from "@/lib/gemini";
import sharp from "sharp";
import fs from "fs";

const WORKSPACE = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SCRATCH = "/private/tmp/claude-501/-Users-admin-Projects-shopcx/c70e6ebd-556b-41d7-a1aa-17c4f938977d/scratchpad";
const PRODUCT = `${SCRATCH}/product-tabs.jpg`;

function fileToDataUri(path: string): string {
  const buf = fs.readFileSync(path);
  return `data:image/jpeg;base64,${buf.toString("base64")}`;
}

const PRODUCT_DESC = `The SECOND image is the REAL product — "SUPERFOOD TABS" by Superfoods Company, an effervescent fizzy-drink tablet you drop in water. Render its real package faithfully: the coral/salmon-to-warm-yellow gradient tube AND the matching box, both reading "SUPERFOOD TABS", "Strawberry Lemonade Flavored", "Dietary Supplement". The tablets are round white effervescent tabs. Keep the real label text crisp and correctly spelled. Alongside the package, ALSO show one tall clear glass of vibrant, freshly-fizzing fruit-colored drink (bright strawberry-lemonade pink/coral) with a tablet dissolving in bubbles — appetizing and premium.`;

const HARD_RULES = `
ABSOLUTE HARD RULES — obey all or the ad is unusable:
- NO price, NO dollar sign, NO dollar figure anywhere.
- NO human face, NO avatar, NO person, NO customer name, NO verified/blue checkmark, NO reviewer attribution.
- NO fake before/after imagery, NO body-shaming, NO "burn fat" / "lose X lbs" / weight-loss-amount claims, NO disease claims.
- Star rating (★★★★★) is allowed ONLY as a product rating, never tied to a named person.
- Spell EVERY word correctly. All text crisp, high-contrast, perfectly legible.
- Real product package must be clearly visible and faithful to the second image.
- Brand palette: deep green #055c3f, warm terracotta #ed886d, cream #f7f1e6 — but the DRINK itself stays vibrant fruit-colored and appetizing.`;

const CONCEPT_1 = `You are designing a premium direct-response comparison static ad for Meta (paid social) for "SUPERFOOD TABS", a superfood effervescent drink tablet for weight management.

The FIRST image is a DESIGN REFERENCE for LAYOUT ONLY — emulate its structure: product package in the upper-left, a bold headline in a rounded highlight block upper-right with chevron arrows, then a large two-column comparison table of rounded-border cells (red ❌ on the left column, green ✅ on the right), and a full-width rounded offer bar across the very bottom. Do NOT copy its brand, its product, or its words.

${PRODUCT_DESC}

Build the ad EXACTLY like this on a rich deep-green (#055c3f) gradient background:

HEADLINE (upper-right, bold, in a soft cream rounded block, deep-green text, with a few terracotta chevron arrows pointing from the product): "Bloated & snacking all afternoon?"

Place the real SUPERFOOD TABS package (tube + box) upper-left, premium and well-lit, with a vibrant glass of the pink strawberry-lemonade fizzy drink beside it.

TWO-COLUMN COMPARISON TABLE (rounded cells, thin cream borders, generous padding):
Left column header (muted): "SODA & SUGARY DRINKS"
  ❌ Sugar crash
  ❌ Cravings & bloat
  ❌ Empty calories
Right column header (bright terracotta #ed886d): "SUPERFOOD TABS"
  ✅ Lighter middle
  ✅ Fewer cravings
  ✅ 16 superfoods, sugar-free
Use a clean red X for the left checks and a bright green check for the right.

TRUST ROW (small, cream text, just above the offer bar): "★★★★★  10,000+ reviews  ·  700,000+ customers  ·  Sugar-Free"

OFFER BAR (full-width rounded pill across the bottom, bright terracotta #ed886d fill, cream bold text): "FREE shipping + up to 34% off"
${HARD_RULES}

Composition: portrait, tall, balanced, calm premium direct-response feel.`;

const CONCEPT_2 = `You are designing a premium direct-response ingredient-breakdown static ad for Meta (paid social) for "SUPERFOOD TABS", a superfood effervescent drink tablet for weight management.

The FIRST image is a DESIGN REFERENCE for LAYOUT ONLY — emulate its structure: a big bold headline across the top, an accented sub-label under it, the product on the LEFT half, and a vertical stack of ingredient→benefit rows on the RIGHT, each row led by a round green icon badge with the ingredient name in bold and its benefit below. Do NOT copy its brand, its product, or its words.

${PRODUCT_DESC}

Build the ad EXACTLY like this on a warm cream (#f7f1e6) background:

HEADLINE (top, very bold, deep-green #055c3f, tight leading): "One Tab. 16 Superfoods."
SUB-LABEL (just under, terracotta #ed886d, with a short terracotta dash rule): "Drop it in water. It works while you sip."

LEFT SIDE: the real SUPERFOOD TABS tube + box, premium, next to a tall glass of vibrant pink strawberry-lemonade fizzy drink with a tablet dissolving in bubbles.

RIGHT SIDE — a clean vertical list of ingredient→benefit rows, each with a round deep-green icon circle, the INGREDIENT in bold deep-green caps and the benefit in muted text below:
  MILK THISTLE — Gentle detox
  MATCHA — Supports metabolism
  DANDELION — De-bloat
  CHLORELLA — Daily cleanse
  GINGER — Easy digestion
  GREEN TEA — Clean energy

TRUST ROW (small, deep-green, near bottom): "★★★★★  10,000+ reviews  ·  Non-GMO  ·  3rd-Party Tested  ·  Made in USA"

OFFER BADGE (rounded pill, terracotta #ed886d fill, cream bold text): "FREE shipping + up to 34% off"
${HARD_RULES}

Composition: portrait, tall, editorial and clean, highly legible.`;

const CONCEPT_3 = `You are designing a premium direct-response "confession / swap" static ad for Meta (paid social) for "SUPERFOOD TABS", a superfood effervescent drink tablet for weight management.

The FIRST image is a DESIGN REFERENCE for LAYOUT ENERGY ONLY — emulate its bold quote-forward feel: a huge dominant hand-set first-person quote filling the top two-thirds, with a couple of phrases highlighted in warm accent blocks, and the product tucked into the lower-right corner. CRITICAL: DO NOT copy or include its person, avatar, face, name, verified badge, or money-back seal — none of those may appear.

${PRODUCT_DESC}

Build the ad EXACTLY like this on a warm cream (#f7f1e6) background:

BIG BOLD FIRST-PERSON QUOTE (dominant, fills the upper two-thirds, deep-green #055c3f, clean modern sans, tight leading) — this is a customer-style confession but with NO name, NO avatar, NO face, NO attribution:
"I swapped my afternoon soda for this. Fewer cravings, a lighter middle — and it actually tastes amazing."
Highlight the phrases "a lighter middle" and "tastes amazing" in warm terracotta (#ed886d) highlight blocks with cream text.

SUPPORT LINE (smaller, below the quote, deep-green): "16 superfoods · sugar-free"

Place the real SUPERFOOD TABS package (tube + box) in the LOWER-RIGHT corner, premium and well-lit, with a tall glass of vibrant pink strawberry-lemonade fizzy drink beside it.

TRUST ROW (small, deep-green, lower-left): "★★★★★  10,000+ reviews  ·  30-Day Money-Back Guarantee"

OFFER BADGE (rounded pill, terracotta #ed886d fill, cream bold text, lower area): "FREE shipping + up to 34% off"
${HARD_RULES}

Composition: portrait, tall. Product clearly visible lower-right. NO human, NO name, NO checkmark, NO seal/stamp.`;

const CONCEPTS: Record<string, { prompt: string; ref: string }> = {
  "1": { prompt: CONCEPT_1, ref: `${SCRATCH}/ref-problem-pivot.jpg` },
  "2": { prompt: CONCEPT_2, ref: `${SCRATCH}/ref-ingredient.jpg` },
  "3": { prompt: CONCEPT_3, ref: `${SCRATCH}/ref-skeptic.jpg` },
};

async function render(concept: string, aspect: "4:5" | "9:16", outW: number, outH: number, outPath: string) {
  const c = CONCEPTS[concept];
  const { buffer } = await generateNanoBananaProCombine({
    workspaceId: WORKSPACE,
    prompt: c.prompt,
    imageUrls: [fileToDataUri(c.ref), fileToDataUri(PRODUCT)],
    aspectRatio: aspect,
  });
  const resized = await sharp(buffer)
    .resize(outW, outH, { fit: "cover", position: "centre" })
    .jpeg({ quality: 92 })
    .toBuffer();
  fs.writeFileSync(outPath, resized);
  console.log(`WROTE ${outPath} (${resized.length} bytes)`);
}

async function main() {
  const concept = process.argv[2] || "1";
  const which = process.argv[3] || "4x5";
  if (which === "4x5") {
    await render(concept, "4:5", 1080, 1350, `${SCRATCH}/tabs-${concept}-4x5.jpg`);
  } else if (which === "9x16") {
    await render(concept, "9:16", 1080, 1920, `${SCRATCH}/tabs-${concept}-9x16.jpg`);
  }
}

main().catch((e) => {
  console.error("FAILED", e);
  process.exit(1);
});
