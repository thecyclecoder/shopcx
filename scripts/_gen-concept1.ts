import { loadEnv } from "./_bootstrap";
loadEnv();
import { generateNanoBananaProCombine } from "@/lib/gemini";
import sharp from "sharp";
import fs from "fs";

const WORKSPACE = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SCRATCH = "/private/tmp/claude-501/-Users-admin-Projects-shopcx/c70e6ebd-556b-41d7-a1aa-17c4f938977d/scratchpad";
const REF = `${SCRATCH}/ref-skeptic.jpg`;
const PRODUCT = "https://urjbhjbygyxffrfkarqn.supabase.co/storage/v1/object/public/product-media/products/fdc11e10-b89f-4989-8b73-ed6526c4d906/ea433e56-0aa4-4b46-9107-feb11f77f533/variants/9ef9311d-57fa-426d-ad0f-250eaeabf122/isolated.png";

// The tool fetches http(s) OR we can pass a data URI. Convert the local ref to a data URI.
function fileToDataUri(path: string): string {
  const buf = fs.readFileSync(path);
  return `data:image/jpeg;base64,${buf.toString("base64")}`;
}

const PROMPT = `You are designing a premium direct-response static ad for Meta (paid social) for "Amazing Coffee", a superfood mushroom coffee.

The FIRST image is a REFERENCE for DESIGN ENERGY ONLY — emulate its bold, quote-forward "skeptic confession" layout: a huge dominant hand-set quote filling the top two-thirds, a couple of phrases highlighted in a warm accent block, the product package tucked into the lower-right corner, and a small wordmark at the lower-left. DO NOT copy its person, avatar, face, name, or verified badge — those must NOT appear.

The SECOND image is the REAL product package — render it faithfully (its real label, real text) resting in the lower-right corner, premium and well-lit.

Build the ad EXACTLY like this:

BIG BOLD QUOTE (dominant, fills upper two-thirds, deep green #055c3f text, clean modern serif/sans, tight leading), set as the BRAND'S OWN first-person voice — NOT a customer testimonial, NO name, NO avatar, NO face, NO quotation attribution:
"Honestly? Mushroom coffee sounded ridiculous to me. Then the fog lifted and the cravings faded."
Highlight the phrases "the fog lifted" and "the cravings faded" in warm terracotta (#ed886d) highlight blocks with cream text, matching the reference's highlight treatment.

SUPPORT LINE (smaller, below the quote, deep green): "12 superfoods in every cup."

OFFER BADGE (a clean pill/badge, terracotta #ed886d fill, cream text, bold): "FREE shipping + up to 34% off"

Background: warm cream (#f7f1e6). Overall feel: premium, calm, highly legible for women aged 50-65.

ABSOLUTE HARD RULES — these must be obeyed or the ad is unusable:
- NO human face, NO avatar, NO person, NO customer name, NO "Diane" or any name.
- NO blue verified checkmark, NO verification badge of any kind.
- NO star rating, NO reviewer, NO testimonial attribution.
- NO money-back guarantee, NO "risk-free", NO "45 days", NO seal/stamp badge.
- NO price, NO dollar sign, NO number of dollars anywhere.
- Spell every word correctly. Text must be crisp and perfectly legible.
- Only the quote, the "12 superfoods in every cup." line, and the "FREE shipping + up to 34% off" badge as text (plus the real package label).

Composition: portrait, tall. Leave the real product package clearly visible bottom-right.`;

async function render(aspect: "4:5" | "9:16", outW: number, outH: number, outPath: string) {
  const { buffer } = await generateNanoBananaProCombine({
    workspaceId: WORKSPACE,
    prompt: PROMPT,
    imageUrls: [fileToDataUri(REF), PRODUCT],
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
  const which = process.argv[2] || "4x5";
  if (which === "4x5") {
    await render("4:5", 1080, 1350, `${SCRATCH}/concept-1-4x5.jpg`);
  } else if (which === "9x16") {
    await render("9:16", 1080, 1920, `${SCRATCH}/concept-1-9x16.jpg`);
  }
}

main().catch((e) => {
  console.error("FAILED", e);
  process.exit(1);
});
