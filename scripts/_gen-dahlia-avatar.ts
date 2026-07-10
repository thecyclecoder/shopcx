/**
 * One-off: generate Dahlia's headshot (the Ad Creative agent — peer to Bianca under Max) and upload it
 * to `agent-avatars/dahlia-ad-creative.jpg`. Mirrors scripts/_gen-marco-avatar.ts (Nano Banana Pro +
 * service-role upload). Filename matches the avatarUrl in src/lib/agents/personas.ts
 * (`${AV}dahlia-ad-creative.jpg?v=1`).
 *
 * Run: npx tsx scripts/_gen-dahlia-avatar.ts
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createClient } from "@supabase/supabase-js";
import { generateNanoBananaProCombine } from "../src/lib/gemini";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const BUCKET = "agent-avatars";
const FILE = "dahlia-ad-creative.jpg";

const HOUSE_STYLE =
  "A PHOTOREALISTIC portrait PHOTOGRAPH of a real-looking person — tight CLOSE CROP (top of head at the top of the frame, cropped just below the collarbone; the face fills the frame), looking at camera, soft editorial lighting, plain neutral background. STYLISH, fashion-forward with real personal taste — modern distinctive outfit, hair, and energy. NOT a boring corporate headshot: NO blazers, NO stiff LinkedIn vibe. NEVER a cartoon / illustration / 3D render / stylized art; NO cheesy props or gimmicks.";

const DAHLIA =
  "The subject is Dahlia, the company's Ad Creative lead — a sharp, tasteful woman in her early 30s who designs the scroll-stopping static ads that feed the media-buyer's test loop. An art-director's eye: she knows exactly what makes a stranger stop scrolling. Effortlessly stylish, creative-studio energy — a modern, well-cut outfit with a bold but refined accent (think a great blouse or a fashion-forward knit, expressive but not costume), interesting layered hair, maybe a subtle statement earring. Subtle warm fuchsia/magenta tones in the lighting. Confident, warm, slightly playful gaze into the camera with a knowing half-smile — the person who makes the thing you can't look away from. High-end editorial fashion-photography quality — creative, discerning, unmistakably the one who makes the ads.";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
  const sb = createClient(url, key);
  console.log("generating Dahlia headshot via Nano Banana Pro …");
  const { buffer, mimeType } = await generateNanoBananaProCombine({
    workspaceId: WS,
    prompt: `${HOUSE_STYLE}\n\n${DAHLIA}`,
    imageUrls: [],
    aspectRatio: "1:1",
  });
  const up = await sb.storage.from(BUCKET).upload(FILE, buffer, { contentType: mimeType, upsert: true });
  if (up.error) throw new Error(`upload ${FILE}: ${up.error.message}`);
  const { writeFileSync } = await import("fs");
  writeFileSync("/Users/admin/Desktop/dahlia-avatar.jpg", buffer);
  console.log(`✓ uploaded ${FILE} — ${buffer.length} bytes (${mimeType})`);
  console.log(`   ${url}/storage/v1/object/public/${BUCKET}/${FILE}`);
}

main().catch((e) => {
  console.error("ERR", e instanceof Error ? e.message : e);
  process.exit(1);
});
