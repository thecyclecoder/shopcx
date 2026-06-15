/**
 * POC v3: generate ingredient "hand-holding-superfood" heroes with Nano Banana
 * Pro (Gemini), upload to the ad-tool bucket, then render ingredient-angle
 * advertorials. Compares against the face/avatar heroes.
 *
 *   npx tsx scripts/render-advertorial-ingredient.ts
 */
import path from "path";
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { createDecipheriv } from "crypto";
import { bundle } from "@remotion/bundler";
import { selectComposition, renderStill } from "@remotion/renderer";

for (const line of readFileSync("/Users/admin/Projects/shopcx/.env.local", "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  if (!process.env[t.slice(0, eq)]) process.env[t.slice(0, eq)] = t.slice(eq + 1);
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

function decrypt(enc: string): string {
  const key = Buffer.from(process.env.ENCRYPTION_KEY!, "hex");
  const [ivHex, tagHex, ctHex] = enc.split(":");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  d.setAuthTag(Buffer.from(tagHex, "hex"));
  return d.update(Buffer.from(ctHex, "hex")).toString("utf8") + d.final("utf8");
}

async function geminiKey(): Promise<string> {
  const { data } = await sb.from("workspaces").select("gemini_api_key_encrypted").eq("id", WS).single();
  if (data?.gemini_api_key_encrypted) return decrypt(data.gemini_api_key_encrypted);
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  throw new Error("no gemini key");
}

// Nano Banana Pro text-to-image (no reference images).
async function genImage(apiKey: string, prompt: string, aspect: string): Promise<Buffer> {
  const res = await fetch(`${GEMINI_BASE}/models/gemini-3-pro-image:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: aspect } } }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`gemini_${res.status}: ${(json?.error?.message || "").slice(0, 160)}`);
  const part = (json?.candidates?.[0]?.content?.parts || []).find((p: any) => p.inline_data || p.inlineData);
  if (!part) throw new Error("gemini_no_image");
  const inline = part.inline_data || part.inlineData;
  return Buffer.from(inline.data, "base64");
}

async function uploadSign(buf: Buffer, key: string): Promise<string> {
  await sb.storage.from("ad-tool").upload(key, buf, { contentType: "image/png", upsert: true });
  const { data } = await sb.storage.from("ad-tool").createSignedUrl(key, 3600);
  return data!.signedUrl;
}

const HEROES = [
  { slug: "chaga", aspect: "3:2",
    prompt: "Editorial wellness magazine photo, landscape orientation. A close-up of an older woman's hands gently holding a cluster of fresh raw chaga mushrooms over a rustic wooden kitchen counter. Soft natural morning window light, shallow depth of field, warm authentic tones, documentary food-photography style. No text, no watermark, no packaging." },
  { slug: "superfood-flatlay", aspect: "3:2",
    prompt: "Editorial wellness magazine flat-lay photo, landscape orientation. Raw medicinal superfoods arranged on a warm wooden surface: chaga and cordyceps mushrooms, fresh turmeric root, green coffee beans, and maca root. Soft natural light, shallow depth of field, earthy authentic tones, premium food-photography style. No text, no watermark, no packaging." },
];

const base = {
  width: 1080, height: 1350,
  publication: "THE SUPERFOODS REPORT", sponsorLabel: "SPONSORED", category: "HEALTH",
  byline: "By the Editorial Team", dateLabel: "June 2026",
  headline: "The Mushrooms Doctors Are Quietly Adding to Their Morning Coffee",
  dek: "Twelve clinically studied superfoods — including chaga, cordyceps and turmeric — in one ordinary-looking cup.",
  heroCaption: "The 12 superfoods inside every cup of Amazing Coffee.",
  body: [
    "For most people over 50, coffee is just a habit. But chaga, cordyceps and turmeric have been studied for years — for clean energy, sharper focus and heart health, without the jitters or afternoon crash.",
  ],
  rating: 5, reviewCount: "2,291",
  badges: ["Non-GMO", "3rd-Party Tested", "Made in USA", "Sugar Free"],
  guarantee: "Backed by a 30-day money-back guarantee.",
  cta: "Read more →", accent: "#B0451C",
  heroHeightPx: 360, heroObjectPosition: "center",
};

async function main() {
  const apiKey = await geminiKey();
  const entry = path.resolve(process.cwd(), "remotion/index.ts");
  console.log("Bundling Remotion…");
  const serveUrl = await bundle({ entryPoint: entry });

  for (const h of HEROES) {
    const key = `poc/advertorial-ingredient/${h.slug}.png`;
    // Reuse a previously generated hero if present (skip Gemini spend); else generate.
    let heroImageUrl: string;
    const existing = await sb.storage.from("ad-tool").createSignedUrl(key, 3600);
    if (existing.data?.signedUrl) {
      console.log(`Reusing existing ${h.slug}`);
      heroImageUrl = existing.data.signedUrl;
    } else {
      console.log(`Generating ${h.slug} via Nano Banana Pro…`);
      const buf = await genImage(apiKey, h.prompt, h.aspect);
      heroImageUrl = await uploadSign(buf, key);
    }
    const props = { ...base, heroImageUrl };
    const composition = await selectComposition({ serveUrl, id: "StaticAdvertorial", inputProps: props });
    const output = `/tmp/advertorial-ingredient-${h.slug}.png`;
    console.log(`Rendering ${h.slug} → ${output}`);
    await renderStill({ composition, serveUrl, output, inputProps: props, frame: 0, overwrite: true });
  }
  console.log("Done.");
}
main().catch((e) => { console.error(e); process.exit(1); });
