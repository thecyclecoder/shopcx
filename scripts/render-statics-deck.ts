/**
 * Killer statics deck: 4 cold-50+ archetypes × {4:5, 9:16}, real Amazing Coffee
 * PI. Generates the few faces/before-shots it needs via Nano Banana Pro
 * (reuse-if-present → no repeat spend), reuses avatar heroes + product image.
 *
 *   npx tsx scripts/render-statics-deck.ts
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
const PID = "ea433e56-0aa4-4b46-9107-feb11f77f533";
// Isolated (transparent-bg) bag — clean on any background. NEVER product-on-white.
const PRODUCT_IMG = "https://urjbhjbygyxffrfkarqn.supabase.co/storage/v1/object/public/product-media/products/fdc11e10-b89f-4989-8b73-ed6526c4d906/ea433e56-0aa4-4b46-9107-feb11f77f533/variants/9ef9311d-57fa-426d-ad0f-250eaeabf122/isolated.png";
// Real assets from product_media (public): use these instead of generating.
const MEDIA = (slot: string, file: string) => `https://urjbhjbygyxffrfkarqn.supabase.co/storage/v1/object/public/product-media/products/ea433e56-0aa4-4b46-9107-feb11f77f533/${slot}/${file}`;
const LINDSEY_RAY = MEDIA("endorsement_1_avatar", "endorsement_1_avatar-1778602104994.jpg"); // real dietitian headshot
const REAL_BEFORE = MEDIA("before", "before-1778595906147.jpg"); // real customer weight-loss photos
const REAL_AFTER = MEDIA("after", "after-1778596558127.jpg");

function decrypt(enc: string): string { const key = Buffer.from(process.env.ENCRYPTION_KEY!, "hex"); const [iv, tag, ct] = enc.split(":"); const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "hex")); d.setAuthTag(Buffer.from(tag, "hex")); return d.update(Buffer.from(ct, "hex")).toString("utf8") + d.final("utf8"); }
async function geminiKey() { const { data } = await sb.from("workspaces").select("gemini_api_key_encrypted").eq("id", WS).single(); if (data?.gemini_api_key_encrypted) return decrypt(data.gemini_api_key_encrypted); if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY; throw new Error("no gemini key"); }
async function gen(apiKey: string, prompt: string, aspect: string): Promise<Buffer> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent`, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: aspect } } }) });
  const json: any = await res.json().catch(() => ({})); if (!res.ok) throw new Error(`gemini_${res.status}: ${(json?.error?.message || "").slice(0, 160)}`);
  const part = (json?.candidates?.[0]?.content?.parts || []).find((p: any) => p.inline_data || p.inlineData); if (!part) throw new Error("no_image");
  const inline = part.inline_data || part.inlineData; return Buffer.from(inline.data, "base64");
}
async function sign(key: string) { const { data } = await sb.storage.from("ad-tool").createSignedUrl(key, 3600); return data?.signedUrl || null; }
async function signRaw(raw?: string | null) { if (!raw) return null; const m = raw.match(/\/ad-tool\/(.+?)(\?|$)/); return sign(m ? decodeURIComponent(m[1]) : raw); }
async function ensure(apiKey: string, key: string, prompt: string, aspect: string): Promise<string> {
  const ex = await sign(key); if (ex) { console.log(`  reuse ${key}`); return ex; }
  console.log(`  generate ${key}`); const buf = await gen(apiKey, prompt, aspect);
  await sb.storage.from("ad-tool").upload(key, buf, { contentType: "image/png", upsert: true }); return (await sign(key))!;
}

async function main() {
  const apiKey = await geminiKey();
  console.log("Ensuring imagery…");
  // Testimonial uses a generated lifestyle model (NOT attributed as the named reviewer).
  const faceWoman = await ensure(apiKey, "poc/statics/face-woman.png", "Authentic headshot portrait of a friendly, healthy woman in her late 50s with grey hair, warm genuine smile, casual sweater, bright home kitchen background softly blurred. Natural light, photorealistic, non-stock, candid. No text.", "1:1");
  // Authority + before/after use REAL product_media assets (no generation).

  const entry = path.resolve(process.cwd(), "remotion/index.ts");
  console.log("Bundling Remotion…");
  const serveUrl = await bundle({ entryPoint: entry });

  const ARCH: Record<string, { id: string; props: Record<string, unknown> }> = {
    testimonial: { id: "StaticTestimonial", props: { brandBg: "#FBF8F2", accent: "#B0451C", quote: "I've lost 32 pounds in 9 weeks.", body: "I started drinking Amazing Coffee 9 weeks ago. Along with a healthy diet, the results have been amazing — and it's the best-tasting coffee I've had.", reviewerName: "Kristen N.", verified: true, faceImageUrl: faceWoman, productImageUrl: PRODUCT_IMG, productTitle: "Amazing Coffee", reviewCount: "12,291", badges: ["Non-GMO", "3rd-Party Tested"], cta: "Shop now →" } },
    authority: { id: "StaticAuthority", props: { brandBg: "#FBF8F2", accent: "#B0451C", expertName: "Lindsey Ray", expertTitle: "Registered Dietitian, MS, RD, LD", quote: "It's rich in antioxidants, supports weight loss, and even improves skin elasticity. You can't ask for a better way to start your day.", bullets: ["Supports healthy weight loss", "Antioxidants that fight aging", "Improves skin elasticity"], faceImageUrl: LINDSEY_RAY, productImageUrl: PRODUCT_IMG, productTitle: "Amazing Coffee", badges: ["Non-GMO", "3rd-Party Tested", "Made in USA"], cta: "Learn more →" } },
    // big-claim now rendered by render-bigclaim-options.ts (contrarian hook poster)
    beforeafter: { id: "StaticBeforeAfter", props: { accent: "#B0451C", headline: "The transformation people are talking about", beforeLabel: "Before", afterLabel: "After", beforeText: "Where she started.", afterText: "Lighter, glowing — and getting compliments.", beforeImageUrl: REAL_BEFORE, afterImageUrl: REAL_AFTER, productTitle: "Amazing Coffee", badges: ["Non-GMO", "3rd-Party Tested"], cta: "Shop now →" } },
  };

  const RATIOS = [
    { tag: "4x5", width: 1080, height: 1350, safeTopPct: 0, safeBottomPct: 0 },
    { tag: "9x16", width: 1080, height: 1920, safeTopPct: 0.08, safeBottomPct: 0.14 },
  ];

  for (const [name, a] of Object.entries(ARCH)) {
    for (const r of RATIOS) {
      const props = { ...a.props, width: r.width, height: r.height, safeTopPct: r.safeTopPct, safeBottomPct: r.safeBottomPct };
      const composition = await selectComposition({ serveUrl, id: a.id, inputProps: props });
      const output = `/tmp/static-${name}-${r.tag}.png`;
      console.log(`Rendering ${name} ${r.tag}`);
      await renderStill({ composition, serveUrl, output, inputProps: props, frame: 0, overwrite: true });
    }
  }
  console.log("Done.");
}
main().catch((e) => { console.error(e); process.exit(1); });
