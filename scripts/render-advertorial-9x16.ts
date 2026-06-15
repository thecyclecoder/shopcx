/**
 * POC: 9:16 (Stories/Reels) advertorial with Meta safe-zone insets. Proves the
 * template renders vertical with the masthead clear of the top overlay and the
 * CTA clear of the bottom nav. Reuses already-stored heroes (no new spend).
 *
 *   npx tsx scripts/render-advertorial-9x16.ts
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

async function sign(key: string) { const { data } = await sb.storage.from("ad-tool").createSignedUrl(key, 3600); return data?.signedUrl || null; }
async function signRaw(raw?: string | null) { if (!raw) return null; const m = raw.match(/\/ad-tool\/(.+?)(\?|$)/); return sign(m ? decodeURIComponent(m[1]) : raw); }

// 9:16: keep content inside ~8% top / ~14% bottom safe insets.
const base = {
  width: 1080, height: 1920,
  publication: "THE SUPERFOODS REPORT", sponsorLabel: "SPONSORED", category: "HEALTH",
  byline: "By the Editorial Team", dateLabel: "June 2026",
  rating: 5, reviewCount: "12,291",
  badges: ["Non-GMO", "3rd-Party Tested", "Made in USA", "Sugar Free"],
  guarantee: "Backed by a 30-day money-back guarantee.",
  cta: "Read more →", accent: "#B0451C",
  safeTopPct: 0.08, safeBottomPct: 0.14, heroHeightPx: 560,
};

async function main() {
  const entry = path.resolve(process.cwd(), "remotion/index.ts");
  console.log("Bundling Remotion…");
  const serveUrl = await bundle({ entryPoint: entry });

  // 1) Ingredient angle (reuse stored chaga hero)
  const chaga = await sign("poc/advertorial-ingredient/chaga.png");
  // 2) Testimonial angle (reuse an avatar holding-product hero)
  const { data: camp } = await sb.from("ad_campaigns").select("hero_image_url").eq("workspace_id", WS)
    .eq("product_id", "ea433e56-0aa4-4b46-9107-feb11f77f533").not("hero_image_url", "is", null).limit(1).single();
  const avatar = await signRaw(camp?.hero_image_url);

  const variants = [
    { slug: "ingredient", heroImageUrl: chaga, heroObjectPosition: "center",
      headline: "The Mushrooms Women Over 50 Add to Their Coffee to Fight Aging",
      dek: "Chaga, cordyceps and turmeric — antioxidants that target the oxidative stress behind visible aging.",
      heroCaption: "The 12 superfoods inside every cup.",
      body: ["Aging shows up first in the mirror. The superfoods in this cup were chosen for exactly that.", "Chaga and turmeric are rich in antioxidants — and customers say their skin looks brighter and firmer within weeks."] },
    { slug: "avatar", heroImageUrl: avatar, heroObjectPosition: "center 25%",
      headline: "The Coffee Helping Women Over 50 Finally Lose the Weight",
      dek: "A simple swap with 12 clinically studied superfoods — for healthy weight and the vitality people notice.",
      heroCaption: "Real customers are swapping their morning cup.",
      body: ["The best part isn't the number on the scale. It's when friends start asking what you've been doing differently.", "Twelve superfoods chosen for healthy weight and radiant skin — in a cup that tastes amazing."] },
  ];

  for (const v of variants) {
    if (!v.heroImageUrl) { console.log(`skip ${v.slug} (no hero)`); continue; }
    const props = { ...base, ...v };
    const composition = await selectComposition({ serveUrl, id: "StaticAdvertorial", inputProps: props });
    const output = `/tmp/advertorial-9x16-${v.slug}.png`;
    console.log(`Rendering 9:16 ${v.slug} → ${output}`);
    await renderStill({ composition, serveUrl, output, inputProps: props, frame: 0, overwrite: true });
  }
  console.log("Done.");
}
main().catch((e) => { console.error(e); process.exit(1); });
