import { loadEnv } from "./_bootstrap";
loadEnv();
import { generateNanoBananaProCombine } from "@/lib/gemini";
import sharp from "sharp";
import fs from "fs";

const WORKSPACE = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SCRATCH = "/private/tmp/claude-501/-Users-admin-Projects-shopcx/c70e6ebd-556b-41d7-a1aa-17c4f938977d/scratchpad";
const PRODUCT_URL =
  "https://cdn.shopify.com/s/files/1/0634/9599/5565/files/Simple_PDP_Superfood_Tabs.jpg?v=1768925189";

function fileToDataUri(path: string): string {
  const buf = fs.readFileSync(path);
  return `data:image/jpeg;base64,${buf.toString("base64")}`;
}

const PROMPT = `The FIRST image is an already-approved, finished direct-response static ad. Reproduce this ad EXACTLY — same layout, same typography, same colors, same copy, same product package, same trust badges, same offer bar/badge, same composition — but change the text "16 superfoods" / "16 Superfoods" to "15 superfoods" / "15 Superfoods" wherever it appears (keep the exact same capitalization, font, weight, color, and position as the original — only the digit changes from 16 to 15). Nothing else changes. Every other word, number, star rating, and pixel must stay identical to the first image.

The SECOND image is the REAL product for reference — keep the product package faithful to it, exactly as shown in the first image.

HARD RULES: NO price, NO dollar sign, NO dollar figure anywhere. NO human face, NO person, NO avatar, NO name, NO verified checkmark. Spell every word correctly; all text crisp and perfectly legible; the new "15" must be crisp and clean. Keep the trust badges and the offer "FREE shipping + up to 34% off" exactly as in the first image.`;

async function render(concept: string, aspect: "4:5" | "9:16", outW: number, outH: number) {
  const outPath = `${SCRATCH}/tabs-${concept}-${aspect.replace(":", "x")}.jpg`;
  const base = fileToDataUri(outPath); // CURRENT render is the design base
  const { buffer } = await generateNanoBananaProCombine({
    workspaceId: WORKSPACE,
    prompt: PROMPT,
    imageUrls: [base, PRODUCT_URL],
    aspectRatio: aspect,
  });
  const resized = await sharp(buffer)
    .resize(outW, outH, { fit: "cover", position: "centre" })
    .jpeg({ quality: 92 })
    .toBuffer();
  fs.writeFileSync(outPath, resized);
  console.log(`WROTE ${outPath} (${resized.length} bytes)`);
}

async function main() {
  const concept = process.argv[2] || "1";
  const which = process.argv[3] || "4x5";
  if (which === "4x5") await render(concept, "4:5", 1080, 1350);
  else if (which === "9x16") await render(concept, "9:16", 1080, 1920);
}

main().catch((e) => {
  console.error("FAILED", e);
  process.exit(1);
});
