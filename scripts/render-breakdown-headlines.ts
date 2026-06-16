/**
 * Render 3 scroll-stopping headline variations of the ingredient-breakdown
 * static (4:5), reusing the cached split-bag hero. Each anchors to a CORE desire
 * (weight / aging / social approval) — never energy/crash.
 *   npx tsx scripts/render-breakdown-headlines.ts
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

const ROWS = [
  { name: "Green Coffee", benefit: "Burns Fat", icon: "flame" },
  { name: "Matcha", benefit: "Metabolism", icon: "bolt" },
  { name: "Chaga", benefit: "Fights Aging", icon: "shield" },
  { name: "Turmeric", benefit: "Radiant Skin", icon: "sun" },
  { name: "Cordyceps", benefit: "Clean Energy", icon: "leaf" },
  { name: "Maca Root", benefit: "Drive", icon: "heart" },
];

const HEADLINES = [
  { tag: "v1-weight", headline: "SHE LOST THE WEIGHT — NOT THE COFFEE." },        // weight loss
  { tag: "v2-aging", headline: "YOUR COFFEE IS AGING YOU. THIS FIGHTS BACK." },   // fighting aging (enemy hook)
  { tag: "v3-social", headline: "EVERYONE KEEPS ASKING WHAT SHE CHANGED." },      // social approval / best self
];

async function main() {
  const { data } = await sb.storage.from("ad-tool").createSignedUrl("poc/statics/breakdown-hero-v4.png", 3600);
  const heroImageUrl = data!.signedUrl;
  const serveUrl = await bundle({ entryPoint: path.resolve(process.cwd(), "remotion/index.ts") });
  for (const h of HEADLINES) {
    const props = { headline: h.headline, heroImageUrl, productLabel: "12 Superfoods in one cup", ingredients: ROWS, width: 1080, height: 1350, safeTopPct: 0, safeBottomPct: 0 };
    const composition = await selectComposition({ serveUrl, id: "StaticIngredientBreakdown", inputProps: props });
    const output = `/tmp/breakdown-${h.tag}.png`;
    console.log(`Rendering ${h.tag}`);
    await renderStill({ composition, serveUrl, output, inputProps: props, frame: 0, overwrite: true });
  }
  console.log("Done.");
}
main().catch((e) => { console.error(e); process.exit(1); });
