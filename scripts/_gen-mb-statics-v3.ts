/**
 * THROWAWAY — generate 3 finished static ads for "Amazing Coffee" by feeding a
 * proven competitor ad as the VISUAL DESIGN REFERENCE alongside our real product
 * package to Nano Banana Pro, asking it to REBUILD the winning ad's layout/style
 * for OUR product + OUR copy. Overwrites concept-N-{4x5,9x16}.jpg in scratchpad.
 *
 * Local ref images -> data: URLs (undici fetch supports data:). Product images
 * pass as their real https URLs.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();

import { readFileSync, writeFileSync } from "fs";
import { generateNanoBananaProCombine, type NanoBananaAspect } from "../src/lib/gemini";

const WORKSPACE = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const DIR = "/private/tmp/claude-501/-Users-admin-Projects-shopcx/c70e6ebd-556b-41d7-a1aa-17c4f938977d/scratchpad";

const COCOA = "https://urjbhjbygyxffrfkarqn.supabase.co/storage/v1/object/public/product-media/products/fdc11e10-b89f-4989-8b73-ed6526c4d906/ea433e56-0aa4-4b46-9107-feb11f77f533/variants/9ef9311d-57fa-426d-ad0f-250eaeabf122/isolated.png";
const HAZELNUT = "https://urjbhjbygyxffrfkarqn.supabase.co/storage/v1/object/public/product-media/products/fdc11e10-b89f-4989-8b73-ed6526c4d906/ea433e56-0aa4-4b46-9107-feb11f77f533/variants/9e2402f1-1821-4a20-ad57-e0c0901efc6b/isolated.png";

function fileToDataUrl(path: string): string {
  const buf = readFileSync(path);
  return `data:image/jpeg;base64,${buf.toString("base64")}`;
}

const BRAND = `Brand palette: deep forest green #055c3f (headlines/accents), warm terracotta #ed886d (offer badge / highlight fills), soft cream #f5efe2 background. Premium, trustworthy, editorial. Audience: women 50-65 — use LARGE, highly legible type. Spell every word correctly. Plain-text claims only, absolutely NO price / no dollar figure anywhere. Keep the real product package pixel-faithful (do not redesign or relabel it). Output a finished, ready-to-run social ad — no crop marks, no watermark, no lorem text.`;

const CONCEPTS: Record<string, { ref: string; product: string; prompt: string }> = {
  "1": {
    ref: `${DIR}/ref-skeptic.jpg`,
    product: COCOA,
    prompt: `The FIRST image is a proven, high-performing testimonial-style social ad (Erth mushroom coffee). The SECOND image is OUR real product package, "Amazing Coffee". Rebuild the FIRST image's exact design language for OUR product: same clean white/cream canvas, same top-left circular reviewer avatar photo of a warm, credible woman aged ~55 with a small blue verified checkmark and a first-name label beside it, the SAME big bold sans-serif testimonial quote where the emotional key phrases are wrapped in solid terracotta highlight blocks with white text (the way the reference highlights phrases in orange), a circular "RISK-FREE / 45 DAYS / 100% MONEY BACK" seal, and OUR product package standing in the lower-right corner. Use THIS testimonial copy verbatim, breaking lines naturally and highlighting the two emotional phrases in terracotta:
Quote body: "Honestly? Mushroom coffee sounded ridiculous to me. Then [the fog lifted] and [the cravings faded] — 12 superfoods in every cup and I feel like myself again."
Highlight "the fog lifted" and "the cravings faded" in terracotta blocks. Reviewer name label: "Diane R.".
Place a terracotta pill offer badge reading "FREE shipping + up to 34% off" near the product. Small brand wordmark "Superfoods Company" in deep green bottom-left. ${BRAND}`,
  },
  "2": {
    ref: `${DIR}/ref-problem-pivot.jpg`,
    product: HAZELNUT,
    prompt: `The FIRST image is a proven, high-performing "problem -> pivot" comparison social ad (Amla Green) on a rich green gradient. The SECOND image is OUR real product package, "Amazing Coffee". Rebuild the FIRST image's exact design system for OUR product: a deep forest-green (#055c3f) gradient background, OUR product package floating top-left, a bold set of animated-style chevron arrows pointing from the product to a large heavy sans-serif headline in the top-right, then a clean two-column rounded comparison card below with an X-column (problems, red X marks) and a check-column (our benefits, green checks), and a rounded terracotta offer bar pinned across the bottom. Use THIS copy exactly:
Headline (top-right, big, in cream/white): "Brain fog & afternoon cravings?"
Comparison card LEFT column header "REGULAR COFFEE" with red X rows: "Jitters, then a crash", "Cravings by mid-afternoon", "Just caffeine, nothing more".
Comparison card RIGHT column header "AMAZING COFFEE" (in bright green) with green check rows: "Sharper focus, no jitters", "Fewer cravings", "12 superfoods in every cup".
Bottom terracotta bar: "FREE shipping + up to 34% off  •  12 Superfoods  •  Energy without jitters".
Do NOT include any price or per-serving cost. ${BRAND}`,
  },
  "3": {
    ref: `${DIR}/ref-ingredient.jpg`,
    product: COCOA,
    prompt: `The FIRST image is a proven, high-performing ingredient-breakdown social ad layout (cream background, big serif headline, a vertical split image of the product package fused with a photographic collage of raw superfood ingredients, and a right-hand column of circular green icons each paired with an ingredient name + short benefit). The SECOND image is OUR real product package, "Amazing Coffee". Rebuild the FIRST image's EXACT layout and typographic style for OUR product, but REPLACE ALL of the reference's claims with the compliant copy below (do NOT reuse the reference's "burns fat / slimmer waist / younger you / lighter scale" wording — those are banned). Layout: soft cream background; top-left a large bold brown serif headline; a thin green rule with an eyebrow line; on the left a striking vertical split showing OUR product package on the left half seamlessly meeting a lush photographic collage of real superfood ingredients (chaga & shiitake mushrooms, cordyceps, turmeric root, maca root, matcha powder, roasted coffee beans, cinnamon) on the right half; and on the right side a vertical stack of six rows, each a circular deep-green icon + INGREDIENT name in bold + a short benefit under it. Use THIS copy exactly:
Headline: "One Cup. 12 Superfoods."
Eyebrow: "EVERY CUP WORKS WHILE YOU SIP"
Six ingredient rows (name bold, benefit under):
GREEN COFFEE — Supports metabolism
MATCHA — Clean focus
TURMERIC — Fights inflammation
CORDYCEPS — Natural energy
MACA ROOT — Daily vitality
CHAGA — Antioxidant defense
Add a terracotta pill offer badge reading "FREE shipping + up to 34% off" tucked cleanly near the bottom. NO price anywhere. ${BRAND}`,
  },
};

async function gen(key: string, aspect: NanoBananaAspect, outName: string) {
  const c = CONCEPTS[key];
  const refUrl = fileToDataUrl(c.ref);
  const { buffer } = await generateNanoBananaProCombine({
    workspaceId: WORKSPACE,
    prompt: c.prompt,
    imageUrls: [refUrl, c.product],
    aspectRatio: aspect,
  });
  const out = `${DIR}/${outName}`;
  writeFileSync(out, buffer);
  console.log(`  wrote ${out} (${buffer.length} bytes)`);
}

async function main() {
  // argv: optional list of concept keys (1 2 3); optional "4x5" or "9x16" to limit ratio
  const args = process.argv.slice(2);
  const ratioArg = args.find((a) => a === "4x5" || a === "9x16");
  const keys = args.filter((a) => ["1", "2", "3"].includes(a));
  const doKeys = keys.length ? keys : ["1", "2", "3"];
  const ratios: { aspect: NanoBananaAspect; suffix: string }[] = [];
  if (!ratioArg || ratioArg === "4x5") ratios.push({ aspect: "4:5", suffix: "4x5" });
  if (!ratioArg || ratioArg === "9x16") ratios.push({ aspect: "9:16", suffix: "9x16" });

  for (const key of doKeys) {
    for (const r of ratios) {
      const name = `concept-${key}-${r.suffix}.jpg`;
      console.log(`concept ${key} @ ${r.aspect} -> ${name}`);
      try {
        await gen(key, r.aspect, name);
      } catch (e: any) {
        console.error(`  FAILED concept ${key} ${r.suffix}: ${e?.message || e}`);
      }
    }
  }
  console.log("done");
}

main();
