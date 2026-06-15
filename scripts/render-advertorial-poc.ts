/**
 * Advertorial 4:5, real Amazing Coffee PI. HERO RULE (Dylan): advertorial heroes
 * are AVATARS or INGREDIENTS — NEVER product-on-white (that reads as an ad and
 * kills the editorial trust). Angles anchor to the CORE desires (weight / aging /
 * best-self / social), never functional energy. Review counts = actual + 10,000.
 *
 *   npx tsx scripts/render-advertorial-poc.ts
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

async function sign(key: string) { const { data } = await sb.storage.from("ad-tool").createSignedUrl(key, 3600); return data?.signedUrl || null; }
async function signRaw(raw?: string | null) { if (!raw) return null; const m = raw.match(/\/ad-tool\/(.+?)(\?|$)/); return sign(m ? decodeURIComponent(m[1]) : raw); }

const base = {
  width: 1080, height: 1350,
  publication: "THE SUPERFOODS REPORT", sponsorLabel: "SPONSORED",
  byline: "By the Editorial Team", dateLabel: "June 2026",
  rating: 5, reviewCount: "12,291",
  badges: ["Non-GMO", "3rd-Party Tested", "Made in USA", "Sugar Free"],
  guarantee: "Backed by a 30-day money-back guarantee.",
  cta: "Read more →", accent: "#B0451C",
  heroHeightPx: 380,
};

async function main() {
  const entry = path.resolve(process.cwd(), "remotion/index.ts");
  console.log("Bundling Remotion…");
  const serveUrl = await bundle({ entryPoint: entry });

  // Heroes: avatar holding-product shots (by scene) + ingredient shots. NO product-on-white.
  const { data: camps } = await sb.from("ad_campaigns").select("scene_style, hero_image_url").eq("workspace_id", WS).eq("product_id", PID).not("hero_image_url", "is", null);
  const heroBy = async (scene: string) => signRaw((camps || []).find((c) => c.scene_style === scene)?.hero_image_url || camps?.[0]?.hero_image_url);
  const avatarA = await heroBy("living_room_couch");
  const avatarB = await heroBy("kitchen_counter");
  const flatlay = await sign("poc/advertorial-ingredient/superfood-flatlay.png");
  const chaga = await sign("poc/advertorial-ingredient/chaga.png");

  const VARIANTS = [
    { slug: "weight", hero: avatarA, pos: "center 25%", cap: "Real customers are swapping their morning cup.",
      category: "WEIGHT LOSS", headline: "The Morning Coffee Helping Women Over 50 Finally Lose the Weight",
      dek: "Twelve clinically studied superfoods in one delicious cup — and the pounds that wouldn't budge start to move.",
      body: ["For a lot of women over 50, the weight stops responding to everything that used to work. A growing number are starting their day with one delicious cup built around 12 clinically studied superfoods.", "Green coffee, maca and chaga are studied for metabolism and appetite — so the coffee you already love quietly works with you, not against you."] },
    { slug: "anti-aging", hero: flatlay, pos: "center", cap: "The 12 superfoods inside every cup.",
      category: "HEALTH", headline: "Why Women Over 50 Are Drinking This Coffee to Fight Aging",
      dek: "The antioxidants of 12 superfoods — in the one habit you already have every morning.",
      body: ["Aging shows up first in the mirror. The superfoods in this cup were chosen for exactly that — antioxidants that fight the oxidative stress behind visible aging.", "Chaga and turmeric are rich in antioxidants, and customers say their skin looks brighter and firmer within weeks."] },
    { slug: "best-self-social", hero: avatarB, pos: "center 25%", cap: "Lighter, brighter — and getting noticed.",
      category: "WELLNESS", headline: "The Coffee That Has People Over 50 Getting Compliments Again",
      dek: "Lighter, brighter, more like yourself — built on 12 clinically studied superfoods.",
      body: ["The best part isn't the number on the scale. It's when friends start asking what you've been doing differently.", "Twelve superfoods chosen for healthy weight, radiant skin and the kind of vitality people notice — in a cup that tastes amazing."] },
    { slug: "weight-BRANDED", hero: avatarA, pos: "center 25%", cap: "Real customers are swapping their morning cup.", fontMode: "branded",
      category: "WEIGHT LOSS", headline: "The Morning Coffee Helping Women Over 50 Finally Lose the Weight",
      dek: "Twelve clinically studied superfoods in one delicious cup — and the pounds that wouldn't budge start to move.",
      body: ["For a lot of women over 50, the weight stops responding to everything that used to work. A growing number are starting their day with one delicious cup built around 12 clinically studied superfoods.", "Green coffee, maca and chaga are studied for metabolism and appetite — so the coffee you already love quietly works with you, not against you."] },
  ];

  for (const v of VARIANTS) {
    const props = { ...base, fontMode: (v as any).fontMode, category: v.category, headline: v.headline, dek: v.dek, body: v.body, heroImageUrl: v.hero, heroObjectPosition: v.pos, heroCaption: v.cap };
    const composition = await selectComposition({ serveUrl, id: "StaticAdvertorial", inputProps: props });
    const output = `/tmp/advertorial-${v.slug}.png`;
    console.log(`Rendering ${v.slug} → ${output}`);
    await renderStill({ composition, serveUrl, output, inputProps: props, frame: 0, overwrite: true });
  }
  console.log("Done.");
}
main().catch((e) => { console.error(e); process.exit(1); });
