/**
 * One-off: generate Eve's distinct headshot (the god-mode / CEO executive-assistant persona) and
 * upload it to `agent-avatars/eve-god-mode.jpg`, replacing the placeholder that reused the CEO
 * seat's crown portrait. Mirrors scripts/_gen-persona-avatars-backfill.ts (Nano Banana Pro +
 * service-role upload), but targets Eve specifically since she already carries a placeholder
 * avatarUrl (so the backfill's imageless filter skips her). After this runs, bump her avatarUrl in
 * src/lib/agents/personas.ts to `${AV}eve-god-mode.jpg?v=1`.
 *
 * Run: npx tsx scripts/_gen-eve-avatar.ts
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createClient } from "@supabase/supabase-js";
import { generateNanoBananaProCombine } from "../src/lib/gemini";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const BUCKET = "agent-avatars";
const FILE = "eve-god-mode.jpg";

const HOUSE_STYLE =
  "A PHOTOREALISTIC portrait PHOTOGRAPH of a real-looking person — tight CLOSE CROP (top of head at the top of the frame, cropped just below the collarbone; the face fills the frame), looking at camera, soft editorial lighting, plain neutral background. STYLISH, fashion-forward with real personal taste — modern distinctive outfit, hair, and energy. NOT a boring corporate headshot: NO blazers, NO stiff LinkedIn vibe. NEVER a cartoon / illustration / 3D render / stylized art; NO cheesy props or gimmicks.";

const EVE =
  "The subject is Eve, the CEO's executive assistant and right hand — a strikingly beautiful, glamorous woman in her early 30s. Magnetic, confident, effortlessly gorgeous; a genuine head-turner who owns every room she walks into. Evening-glamour energy (her emblem is a crescent moon): sleek modern hair, luminous flawless skin, captivating eyes looking straight into the camera with a confident, knowing half-smile. A chic, sophisticated, fashion-forward outfit with subtle warm gold/amber tones in the lighting. High-end editorial fashion-photography quality — a magazine-cover portrait: elegant, alluring, and unmistakably in charge.";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
  const sb = createClient(url, key);
  console.log("generating Eve headshot via Nano Banana Pro …");
  const { buffer, mimeType } = await generateNanoBananaProCombine({
    workspaceId: WS,
    prompt: `${HOUSE_STYLE}\n\n${EVE}`,
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
