import { loadEnv } from "./_bootstrap";
loadEnv();
import { readFileSync, writeFileSync } from "fs";
import { generateNanoBananaProCombine } from "../src/lib/gemini";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const BASE = "/Users/admin/Desktop/Superfood-Tabs-PeachMango-fizz.jpg";
const uri = `data:image/jpeg;base64,${readFileSync(BASE).toString("base64")}`;

const PRESERVE = `The PROVIDED IMAGE is a finished product photo we love: a tall clear glass of peachy-orange Peach Mango sparkling drink with an effervescent white tablet FIZZING at the bottom, peach slices, ice, on a soft warm cream editorial background with a long soft shadow. PRESERVE this photograph EXACTLY — same glass, same drink color, same fizzing tablet and rising bubbles, same peach slices, same background, lighting, shadow, framing and composition. Do NOT alter the photo itself. ONLY replace the headline with a more dynamic, designed STATIC-AD typographic treatment. Every letter must be perfectly and correctly spelled, crisply kerned, never garbled. Output a crisp 1:1 square.`;

const variants = [
  { tag: "v2a-hero", spec: `${PRESERVE}
Text treatment: a bold premium ad lockup in the upper-left negative space, Montserrat-style geometric sans-serif. Set the word "FIZZ" oversized and extra-bold with a vibrant peach-to-mango orange gradient fill; directly under it set "for your health" in a clean medium weight in soft charcoal. Below that, a small letter-spaced uppercase kicker reading "PEACH MANGO · CLEANSING HYDRATION" in light caps. Tasteful, premium, high-contrast, ad-quality.` },
  { tag: "v2b-energetic", spec: `${PRESERVE}
Text treatment: an energetic ad headline across the top, Montserrat-style geometric sans-serif. Set "Fizz for your health" with the word "Fizz" in heavy bold and a lively hand-drawn peachy-orange underline swoosh beneath it, the remaining words in a lighter charcoal weight. Add a small circular ad badge in a top corner reading "PEACH MANGO" in clean uppercase. Playful but premium and clean.` },
];

async function main(){
  for (const v of variants) {
    console.log(`generating ${v.tag}…`);
    const { buffer, mimeType } = await generateNanoBananaProCombine({
      workspaceId: WS, prompt: v.spec, imageUrls: [uri], aspectRatio: "1:1",
    });
    const ext = mimeType.includes("jpeg") ? "jpg" : "png";
    const out = `/Users/admin/Desktop/Superfood-Tabs-PeachMango-fizz-${v.tag}.${ext}`;
    writeFileSync(out, buffer);
    console.log(`  ✓ ${out} (${(buffer.length/1024/1024).toFixed(2)}MB)`);
  }
}
main().then(()=>process.exit(0)).catch((e)=>{console.error("FAILED:", String(e).slice(0,300));process.exit(1);});
