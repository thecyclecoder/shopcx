import { loadEnv } from "./_bootstrap";
loadEnv();
import { readFileSync, writeFileSync } from "fs";
import { generateNanoBananaProCombine } from "../src/lib/gemini";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const DIR = "/Users/admin/Downloads/ShopCX Variant Images (5)/";
function dataUri(path: string): string {
  const b = readFileSync(path);
  return `data:image/png;base64,${b.toString("base64")}`;
}
const box   = dataUri(DIR + "Superfood Tabs Peach Mango.png"); // 1st: box
const tube  = dataUri(DIR + "18.png");                          // 2nd: tube
const drink = dataUri(DIR + "17.png");                          // 3rd: prepared drink

const prompt = `Photorealistic 1:1 lifestyle product photograph for a premium wellness brand — Superfood Tabs, Peach Mango flavor — styled as part of a healthy morning routine on a clean, bright kitchen counter with soft natural window light and a shallow depth of field.

Feature ALL THREE provided products together as the hero group, arranged naturally and tastefully:
- The FIRST image is the Peach Mango retail BOX — place it standing upright as the anchor.
- The SECOND image is the Peach Mango TABS TUBE — stand it beside the box, slightly forward.
- The THIRD image is the finished, prepared drink — a tall clear glass of peachy-orange Peach Mango beverage over ice — place it in the foreground as the "made" result.

Around and between the products, artfully scatter fresh premium SUPERFOOD INGREDIENTS to signal high value and efficacy: a whole pomegranate plus one split open showing ruby arils, milk thistle (spiky purple flower + seeds), vibrant green matcha powder in a small dish with a bamboo scoop, a knob of fresh ginger root, and a burdock root. Keep the styling clean and editorial, not cluttered — negative space, a few water droplets on the glass, a light wooden or marble counter, a softly blurred bright kitchen background.

PRODUCT FIDELITY (critical): reproduce each product package EXACTLY from the provided images — the real "SUPERFOOD TABS" wordmark, the orange/white color system, the Peach Mango label art, and layout. Every piece of legible text must be real, correctly-spelled English exactly as on the real packaging — never invent, garble, or scramble any text or logo. Fine print may be softly out of focus like a real photo, but nothing misspelled.

Do NOT add any marketing copy, headlines, badges, price tags, or graphic overlays — this is a clean photoreal product-in-scene shot only. Output a crisp, high-resolution 1:1 square image.`;

async function main() {
  console.log("generating (Nano Banana Pro, 1:1, 3 references)…");
  const { buffer, mimeType } = await generateNanoBananaProCombine({
    workspaceId: WS,
    prompt,
    imageUrls: [box, tube, drink],
    aspectRatio: "1:1",
  });
  const ext = mimeType.includes("jpeg") ? "jpg" : "png";
  const out = `/Users/admin/Desktop/Superfood-Tabs-PeachMango-lifestyle.${ext}`;
  writeFileSync(out, buffer);
  console.log(`✓ saved ${(buffer.length/1024/1024).toFixed(2)}MB → ${out}`);
}
main().then(()=>process.exit(0)).catch((e)=>{console.error("FAILED:", String(e).slice(0,300));process.exit(1);});
