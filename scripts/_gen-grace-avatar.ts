/**
 * One-off: generate Grace's headshot (the CFO director persona) and upload it to
 * `agent-avatars/grace-cfo.jpg`. Mirrors scripts/_gen-eve-avatar.ts (Nano Banana Pro +
 * service-role upload). The filename matches the avatarUrl in src/lib/agents/personas.ts
 * (`${AV}grace-cfo.jpg?v=1`).
 *
 * Run: npx tsx scripts/_gen-grace-avatar.ts
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createClient } from "@supabase/supabase-js";
import { generateNanoBananaProCombine } from "../src/lib/gemini";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const BUCKET = "agent-avatars";
const FILE = "grace-cfo.jpg";

const HOUSE_STYLE =
  "A PHOTOREALISTIC portrait PHOTOGRAPH of a real-looking person — tight CLOSE CROP (top of head at the top of the frame, cropped just below the collarbone; the face fills the frame), looking at camera, soft editorial lighting, plain neutral background. STYLISH, fashion-forward with real personal taste — modern distinctive outfit, hair, and energy. NOT a boring corporate headshot: NO blazers, NO stiff LinkedIn vibe. NEVER a cartoon / illustration / 3D render / stylized art; NO cheesy props or gimmicks.";

const GRACE =
  "The subject is Grace, the company's CFO — a poised, sharp woman in her early 40s who owns the numbers cold. Composed and quietly authoritative, the person in the room everyone trusts to have done the math. Elegant, understated modern style with real taste: sleek shoulder-length dark hair, refined minimalist outfit in a rich fabric (a fine-knit top or silk — NOT a blazer), a single tasteful piece of jewelry. Subtle cool teal/green tones in the lighting. Calm, direct, intelligent gaze straight into the camera with the faintest confident half-smile. High-end editorial fashion-photography quality — refined, precise, unmistakably the one who keeps score.";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
  const sb = createClient(url, key);
  console.log("generating Grace headshot via Nano Banana Pro …");
  const { buffer, mimeType } = await generateNanoBananaProCombine({
    workspaceId: WS,
    prompt: `${HOUSE_STYLE}\n\n${GRACE}`,
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
