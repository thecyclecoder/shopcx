/**
 * POC v2: advertorial with REAL avatar-holding-product heroes pulled from the
 * existing ad library (ad_campaigns.hero_image_url), instead of product-on-white.
 * Signs fresh ad-tool URLs, then renders one advertorial per scene style.
 *
 *   npx tsx scripts/render-advertorial-avatar.ts
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

async function sign(raw?: string | null): Promise<string | null> {
  if (!raw) return null;
  const m = raw.match(/\/ad-tool\/(.+?)(\?|$)/);
  const key = m ? decodeURIComponent(m[1]) : raw;
  const { data } = await sb.storage.from("ad-tool").createSignedUrl(key, 3600);
  return data?.signedUrl || null;
}

const base = {
  width: 1080, height: 1350,
  publication: "THE SUPERFOODS REPORT", sponsorLabel: "SPONSORED", category: "HEALTH",
  byline: "By the Editorial Team", dateLabel: "June 2026",
  headline: "The Morning Coffee Doctors Wish More People Over 50 Knew About",
  dek: "It looks like regular coffee. But 12 clinically studied superfoods are doing the quiet work behind the scenes.",
  heroCaption: "Real customers are swapping their morning cup.",
  body: [
    "Most people over 50 reach for coffee out of habit. A growing number are swapping it for one with 12 clinically studied superfoods — clean energy and sharper focus, without the jitters or the 2pm crash.",
  ],
  rating: 5, reviewCount: "2,291",
  badges: ["Non-GMO", "3rd-Party Tested", "Made in USA", "Sugar Free"],
  guarantee: "Backed by a 30-day money-back guarantee.",
  cta: "Read more →", accent: "#B0451C",
  heroHeightPx: 360, heroObjectPosition: "center 28%",
};

async function main() {
  const { data: camps } = await sb.from("ad_campaigns")
    .select("id, scene_style, hero_image_url")
    .eq("workspace_id", WS).eq("product_id", "ea433e56-0aa4-4b46-9107-feb11f77f533")
    .not("hero_image_url", "is", null).order("created_at", { ascending: false });

  const entry = path.resolve(process.cwd(), "remotion/index.ts");
  console.log("Bundling Remotion…");
  const serveUrl = await bundle({ entryPoint: entry });

  for (const c of (camps || []).slice(0, 3)) {
    const heroImageUrl = await sign(c.hero_image_url);
    if (!heroImageUrl) { console.log(`skip ${c.scene_style} (no signed url)`); continue; }
    const props = { ...base, heroImageUrl };
    const composition = await selectComposition({ serveUrl, id: "StaticAdvertorial", inputProps: props });
    const output = `/tmp/advertorial-avatar-${c.scene_style}.png`;
    console.log(`Rendering ${c.scene_style} → ${output}`);
    await renderStill({ composition, serveUrl, output, inputProps: props, frame: 0, overwrite: true });
  }
  console.log("Done.");
}
main().catch((e) => { console.error(e); process.exit(1); });
