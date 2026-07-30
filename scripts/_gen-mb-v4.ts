/**
 * THROWAWAY — v4 trust-element pass. Each concept's ALREADY-GREAT v3 render is fed
 * back in as the DESIGN BASE (first image) alongside our real product package
 * (second image). Nano Banana Pro is asked to REPRODUCE the base's exact layout /
 * typography / colors / copy and ONLY add the verified trust elements below.
 * Overwrites concept-N-{4x5,9x16}.jpg in scratchpad. Bases read from v3-base/.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();

import { readFileSync, writeFileSync } from "fs";
import { generateNanoBananaProCombine, type NanoBananaAspect } from "../src/lib/gemini";

const WORKSPACE = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const DIR = "/private/tmp/claude-501/-Users-admin-Projects-shopcx/c70e6ebd-556b-41d7-a1aa-17c4f938977d/scratchpad";
const BASE = `${DIR}/v3-base`; // untouched v3 renders used as the design base

const COCOA = "https://urjbhjbygyxffrfkarqn.supabase.co/storage/v1/object/public/product-media/products/fdc11e10-b89f-4989-8b73-ed6526c4d906/ea433e56-0aa4-4b46-9107-feb11f77f533/variants/9ef9311d-57fa-426d-ad0f-250eaeabf122/isolated.png";
const HAZELNUT = "https://urjbhjbygyxffrfkarqn.supabase.co/storage/v1/object/public/product-media/products/fdc11e10-b89f-4989-8b73-ed6526c4d906/ea433e56-0aa4-4b46-9107-feb11f77f533/variants/9e2402f1-1821-4a20-ad57-e0c0901efc6b/isolated.png";

function fileToDataUrl(path: string): string {
  return `data:image/jpeg;base64,${readFileSync(path).toString("base64")}`;
}

const GUARD = `Brand palette: deep forest green #055c3f, warm terracotta #ed886d, soft cream background. Premium, trustworthy, editorial; audience women 50-65 so keep every word LARGE and highly legible. Reproduce the FIRST (design-base) image's EXACT layout, typography, colors and composition and keep ALL of its existing copy word-for-word — do not move, restyle, recolor, resize, or reword anything already there, and keep the real product package pixel-faithful. The ONLY change is to ADD the trust elements below, integrated cleanly into existing whitespace so the ad stays uncluttered. HARD RULES: absolutely NO price and no dollar figure anywhere. Do NOT add any person, face, avatar, human name, or verified-checkmark — the star ratings are PRODUCT ratings, never attributed to a person. Spell every added word correctly. Output a finished ready-to-run ad, no crop marks, no watermark, no lorem text.`;

const CONCEPTS: Record<string, { product: string; prompt: string }> = {
  "1": {
    product: COCOA,
    prompt: `The FIRST image is our finished skeptic-testimonial ad (bold green quote with terracotta highlight blocks, product package lower-right, "12 superfoods in every cup" line, and a terracotta "FREE shipping + up to 34% off" pill). The SECOND image is our real product package. Reproduce it exactly and ADD, near the offer pill in the lower-left area: (a) a small single-line trust bar in deep green reading exactly: ★★★★★  ·  700,000+ customers  ·  30-Day Money-Back Guarantee ; and (b) directly under it a tiny uppercase certification row reading exactly: NON-GMO · SUGAR-FREE · MADE IN USA . Keep these small and tidy so they support (not crowd) the existing quote and offer pill. ${GUARD}`,
  },
  "2": {
    product: HAZELNUT,
    prompt: `The FIRST image is our finished "REGULAR COFFEE vs AMAZING COFFEE" comparison-table ad on a deep green background (headline "Brain fog & afternoon cravings?", a two-column check/X table, and a bottom terracotta offer bar). The SECOND image is our real product package. Reproduce it exactly. Keep every existing table row unchanged. ADD: (a) a short single-line certification badge strip in cream/white small caps, placed in the gap BETWEEN the comparison table and the bottom offer bar, reading exactly: SUGAR-FREE · NON-GMO · 3RD-PARTY TESTED ; and (b) extend the FIRST line of the bottom terracotta offer bar so it reads exactly: FREE shipping + up to 34% off · 700,000+ customers · 30-day money-back guarantee — and keep the existing second line "12 Superfoods • Energy without jitters" unchanged. ${GUARD}`,
  },
  "3": {
    product: COCOA,
    prompt: `The FIRST image is our finished ingredient-breakdown ad on a cream background (headline "One Cup. 12 Superfoods.", eyebrow "EVERY CUP WORKS WHILE YOU SIP", a vertical split of the product package fused with a superfood-ingredient collage, a right-hand column of six green-icon ingredient→benefit rows, and a terracotta "FREE shipping + up to 34% off" pill). The SECOND image is our real product package. Reproduce it exactly and ADD three trust elements, all cleanly placed in existing whitespace: (a) a small terracotta award ribbon/badge near the TOP-right corner reading exactly, on two lines: "Best Tasting Superfood Coffee" / — Gourmet Magazine ; (b) a small deep-green rating line right beside or just above the offer pill reading exactly: ★★★★★ 10,000+ reviews ; and (c) a slim uppercase certification row across the very BOTTOM reading exactly: 3RD-PARTY TESTED · NON-GMO · SUGAR-FREE · MADE IN USA . Keep the six ingredient rows and headline untouched. ${GUARD}`,
  },
};

async function gen(key: string, aspect: NanoBananaAspect, suffix: string) {
  const c = CONCEPTS[key];
  const baseUrl = fileToDataUrl(`${BASE}/concept-${key}-${suffix}.jpg`);
  const { buffer } = await generateNanoBananaProCombine({
    workspaceId: WORKSPACE,
    prompt: c.prompt,
    imageUrls: [baseUrl, c.product],
    aspectRatio: aspect,
  });
  const out = `${DIR}/concept-${key}-${suffix}.jpg`;
  writeFileSync(out, buffer);
  console.log(`  wrote ${out} (${buffer.length} bytes)`);
}

async function main() {
  const args = process.argv.slice(2);
  const ratioArg = args.find((a) => a === "4x5" || a === "9x16");
  const keys = args.filter((a) => ["1", "2", "3"].includes(a));
  const doKeys = keys.length ? keys : ["1", "2", "3"];
  const ratios: { aspect: NanoBananaAspect; suffix: string }[] = [];
  if (!ratioArg || ratioArg === "4x5") ratios.push({ aspect: "4:5", suffix: "4x5" });
  if (!ratioArg || ratioArg === "9x16") ratios.push({ aspect: "9:16", suffix: "9x16" });

  for (const key of doKeys) {
    for (const r of ratios) {
      console.log(`concept ${key} @ ${r.aspect} -> concept-${key}-${r.suffix}.jpg`);
      try {
        await gen(key, r.aspect, r.suffix);
      } catch (e: any) {
        console.error(`  FAILED concept ${key} ${r.suffix}: ${e?.message || e}`);
      }
    }
  }
  console.log("done");
}

main();
