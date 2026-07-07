import { loadEnv } from "./_bootstrap";
loadEnv();
import { generateNanoBananaProCombine } from "../src/lib/gemini";
import fs from "node:fs";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const PROMPT =
  "A clean, modern set of THREE circular trust-seal badges arranged in a neat horizontal row, on a plain solid white background, for a premium superfood coffee brand. " +
  "Left badge reads 'NON-GMO'. Center badge reads '3RD-PARTY TESTED'. Right badge reads 'MADE IN USA' with a small, subtle US-flag stars-and-stripes motif. " +
  "Each is a simple, minimal, flat vector-style seal — a thin double-ring border, a small icon (a leaf for non-GMO, a checkmark/flask for tested, a flag/shield for USA), and crisp, perfectly legible bold sans-serif text. " +
  "Warm earthy accent color (deep amber/olive) on white, premium and tidy. " +
  "These are GENERIC trust badges — NOT official certification logos, NO Non-GMO Project butterfly, NO USDA organic seal, no trademarked marks. Evenly spaced, centered, no product, no people, no extra text or watermark.";
async function main() {
  const { buffer, mimeType } = await generateNanoBananaProCombine({ workspaceId: WS, prompt: PROMPT, imageUrls: [], aspectRatio: "3:2" });
  const out = "/private/tmp/claude-501/-Users-admin-Projects-shopcx/60367958-34d7-4deb-87f6-6a78358e5fab/scratchpad/trust-badges.jpg";
  fs.writeFileSync(out, buffer);
  console.log(`generated ${buffer.length} bytes (${mimeType}) → ${out}`);
}
main().catch((e) => { console.error("ERR", e instanceof Error ? e.message : e); process.exit(1); });
