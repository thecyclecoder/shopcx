/**
 * One-off: generate Marco's headshot (the Logistics director persona) and upload it to
 * `agent-avatars/marco-logistics.jpg`. Mirrors scripts/_gen-eve-avatar.ts (Nano Banana Pro +
 * service-role upload). The filename matches the avatarUrl in src/lib/agents/personas.ts
 * (`${AV}marco-logistics.jpg?v=1`).
 *
 * Run: npx tsx scripts/_gen-marco-avatar.ts
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createClient } from "@supabase/supabase-js";
import { generateNanoBananaProCombine } from "../src/lib/gemini";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const BUCKET = "agent-avatars";
const FILE = "marco-logistics.jpg";

const HOUSE_STYLE =
  "A PHOTOREALISTIC portrait PHOTOGRAPH of a real-looking person — tight CLOSE CROP (top of head at the top of the frame, cropped just below the collarbone; the face fills the frame), looking at camera, soft editorial lighting, plain neutral background. STYLISH, fashion-forward with real personal taste — modern distinctive outfit, hair, and energy. NOT a boring corporate headshot: NO blazers, NO stiff LinkedIn vibe. NEVER a cartoon / illustration / 3D render / stylized art; NO cheesy props or gimmicks.";

const MARCO =
  "The subject is Marco, the company's Logistics director — a grounded, capable man in his late 30s who keeps the whole supply chain moving. Practical and unflappable, the operator who always knows where every box is. Rugged-modern style with genuine taste: short well-kept dark hair, a few days of stubble, a well-made casual outfit (a quality henley or a modern workwear jacket over a plain tee — NOT a suit, NO blazer). Subtle warm amber/orange tones in the lighting. Steady, direct, confident gaze into the camera with an easy, capable half-smile. High-end editorial fashion-photography quality — warm, dependable, unmistakably the one who makes sure it ships.";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
  const sb = createClient(url, key);
  console.log("generating Marco headshot via Nano Banana Pro …");
  const { buffer, mimeType } = await generateNanoBananaProCombine({
    workspaceId: WS,
    prompt: `${HOUSE_STYLE}\n\n${MARCO}`,
    imageUrls: [],
    aspectRatio: "1:1",
  });
  const up = await sb.storage.from(BUCKET).upload(FILE, buffer, { contentType: mimeType, upsert: true });
  if (up.error) throw new Error(`upload ${FILE}: ${up.error.message}`);
  console.log(`✓ uploaded ${FILE} — ${buffer.length} bytes (${mimeType})`);
  console.log(`   ${url}/storage/v1/object/public/${BUCKET}/${FILE}`);
}

main().catch((e) => {
  console.error("ERR", e instanceof Error ? e.message : e);
  process.exit(1);
});
