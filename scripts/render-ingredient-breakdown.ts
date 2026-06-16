/**
 * Killer static #6 — INGREDIENT BREAKDOWN poster (erth.labs-style).
 * Generates the split-bag cutaway hero via Nano Banana Pro (real bag + real
 * ingredient photos, reuse-if-present → no repeat spend), then renders 4:5 + 9:16
 * with real Amazing Coffee data.
 *
 *   npx tsx scripts/render-ingredient-breakdown.ts
 */
import path from "path";
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { bundle } from "@remotion/bundler";
import { selectComposition, renderStill } from "@remotion/renderer";

for (const line of readFileSync("/Users/admin/Projects/shopcx/.env.local", "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  if (!process.env[t.slice(0, eq)]) process.env[t.slice(0, eq)] = t.slice(eq + 1);
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const PID = "ea433e56-0aa4-4b46-9107-feb11f77f533";

// Real public assets (NEVER product-on-white — the isolated cutout floats clean).
const BAG = "https://urjbhjbygyxffrfkarqn.supabase.co/storage/v1/object/public/product-media/products/fdc11e10-b89f-4989-8b73-ed6526c4d906/ea433e56-0aa4-4b46-9107-feb11f77f533/variants/9ef9311d-57fa-426d-ad0f-250eaeabf122/isolated.png";
const ING = (slot: string, file: string) => `https://urjbhjbygyxffrfkarqn.supabase.co/storage/v1/object/public/product-media/products/ea433e56-0aa4-4b46-9107-feb11f77f533/${slot}/${file}`;
const ING_REFS = [
  ING("ingredient_cordyceps", "ingredient_cordyceps-1778598824934.jpg"),
  ING("ingredient_shiitake", "ingredient_shiitake-1778598835392.jpg"),
  ING("ingredient_maca_root", "ingredient_maca_root-1778598843061.jpg"),
  ING("ingredient_matcha", "ingredient_matcha-1778598867182.jpg"),
  ING("ingredient_green_coffee", "ingredient_green_coffee-1778598850639.jpg"),
];

const HERO_PROMPT = `Using the FIRST image (a stand-up coffee pouch) and the following ingredient reference photos, create ONE photorealistic product hero on a fully transparent background.
The coffee pouch stands upright, centered. Its RIGHT HALF is rendered as a clean vertical cross-section "cutaway" — as if the pouch were sliced open — revealing the real ingredients densely stacked INSIDE the bag, from top to bottom: pale cluster mushrooms, reddish-orange cordyceps, sliced brown mushrooms, light woody roots, bright green matcha powder, then roasted coffee beans at the very bottom.
Keep the LEFT HALF as the actual intact pouch with its original packaging artwork and text sharp and legible. Warm, soft studio lighting that matches the pouch. No added text, no labels, no callouts, no shadow.
CRITICAL background requirement: place the pouch on a SOLID FLAT PURE MAGENTA background, hex #FF00FF, perfectly even and uniform edge to edge. No gradient, no checkerboard, no texture, no other objects — just the single composited pouch on flat magenta so it can be cleanly keyed out.`;

const ROWS = [
  { name: "Green Coffee", benefit: "Burns Fat", icon: "flame" },
  { name: "Matcha", benefit: "Metabolism", icon: "bolt" },
  { name: "Chaga", benefit: "Fights Aging", icon: "shield" },
  { name: "Turmeric", benefit: "Radiant Skin", icon: "sun" },
  { name: "Cordyceps", benefit: "Clean Energy", icon: "leaf" },
  { name: "Maca Root", benefit: "Drive", icon: "heart" },
];

async function sign(key: string) { const { data } = await sb.storage.from("ad-tool").createSignedUrl(key, 3600); return data?.signedUrl || null; }

/** Key the flat-magenta background to true alpha (Nano Banana won't emit alpha
 *  itself — it bakes a checkerboard — so we generate on chroma magenta + key). */
async function chromaKeyMagenta(buf: Buffer): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  for (let i = 0; i < data.length; i += channels) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    // magenta = high R + high B + low G. Soft-key the anti-aliased fringe too.
    if (r > 120 && b > 120 && g < 130 && r - g > 45 && b - g > 45) {
      data[i + 3] = 0;
    } else if (r - g > 25 && b - g > 25 && g < 170) {
      // partial magenta spill on the subject edge → ramp alpha + neutralise tint
      const spill = Math.min(r, b) - g;
      data[i + 3] = Math.max(0, Math.min(255, 255 - spill * 3));
      data[i + 1] = Math.round((r + b) / 2 * 0.6 + g * 0.4); // pull green up to kill pink fringe
    }
  }
  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

async function ensureHero(): Promise<string> {
  const key = "poc/statics/breakdown-hero-v4.png";
  const existing = await sign(key);
  if (existing) { console.log(`  reuse ${key}`); return existing; }
  const sharp = (await import("sharp")).default;
  // Reuse the already-keyed v3 composite if present (don't re-gamble on Nano);
  // its only flaw was transparent padding around the bag → trim it tight.
  let keyed: Buffer;
  const v3 = await sign("poc/statics/breakdown-hero-v3.png");
  if (v3) {
    console.log("  reuse v3 keyed composite → trim");
    keyed = Buffer.from(await (await fetch(v3)).arrayBuffer());
  } else {
    console.log(`  generate (Nano Banana Pro split-bag cutaway + chroma key)…`);
    const { generateNanoBananaProCombine } = await import("../src/lib/gemini");
    const { buffer } = await generateNanoBananaProCombine({ workspaceId: WS, prompt: HERO_PROMPT, imageUrls: [BAG, ...ING_REFS], aspectRatio: "3:4" });
    keyed = await chromaKeyMagenta(buffer);
  }
  // Trim the fully-transparent border so the bag fills its column (kills the
  // left/right negative space + makes the product read bigger).
  const trimmed = await sharp(keyed).trim({ threshold: 12 }).png().toBuffer();
  await sb.storage.from("ad-tool").upload(key, trimmed, { contentType: "image/png", upsert: true });
  return (await sign(key))!;
}

async function main() {
  void PID;
  const heroImageUrl = await ensureHero();
  const entry = path.resolve(process.cwd(), "remotion/index.ts");
  console.log("Bundling Remotion…");
  const serveUrl = await bundle({ entryPoint: entry });

  const RATIOS = [
    { tag: "4x5", width: 1080, height: 1350, safeTopPct: 0, safeBottomPct: 0 },
    { tag: "9x16", width: 1080, height: 1920, safeTopPct: 0.08, safeBottomPct: 0.14 },
  ];
  for (const r of RATIOS) {
    const props = { headline: "THE LONGER YOU DRINK IT, THE MORE IT WORKS.", heroImageUrl, productLabel: "12 Superfoods in one cup", ingredients: ROWS, width: r.width, height: r.height, safeTopPct: r.safeTopPct, safeBottomPct: r.safeBottomPct };
    const composition = await selectComposition({ serveUrl, id: "StaticIngredientBreakdown", inputProps: props });
    const output = `/tmp/breakdown-${r.tag}.png`;
    console.log(`Rendering ${r.tag} → ${output}`);
    await renderStill({ composition, serveUrl, output, inputProps: props, frame: 0, overwrite: true });
  }
  console.log("Done. /tmp/breakdown-4x5.png  /tmp/breakdown-9x16.png");
}
main().catch((e) => { console.error(e); process.exit(1); });
