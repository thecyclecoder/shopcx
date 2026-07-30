import { loadEnv } from "./_bootstrap";
loadEnv();
import { readFileSync, writeFileSync } from "fs";
import { generateNanoBananaProCombine } from "../src/lib/gemini";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const REF = "/Users/admin/Downloads/PDP_Superfood_Tabs_8.jpg";
function dataUri(p: string){ return `data:image/jpeg;base64,${readFileSync(p).toString("base64")}`; }

const prompt = `Photorealistic 1:1 studio product photograph, clean bright editorial wellness style. Match the PROVIDED REFERENCE IMAGE's composition, framing, lighting and mood EXACTLY: a single tall clear glass centered on a soft warm cream/beige surface, gentle natural window light casting soft long shadows, minimal and premium, lots of calm negative space.

Change the beverage to PEACH MANGO flavor:
- The liquid is a vibrant, natural PEACHY-ORANGE (not pink).
- Inside the glass: clear ice cubes and, as the hero moment, an effervescent white SUPERFOOD TABS tablet DISSOLVING at the bottom — actively FIZZING and releasing a lively, dense stream of tiny bubbles rising up through the drink (keep this exactly like the reference's fizzing tablet).
- Garnish to illustrate the flavor: a couple of thin fresh PEACH slices and ripe MANGO slices floating in and resting on the glass — replace the lemon with peach + mango.

Add a short headline set in a clean modern GEOMETRIC SANS-SERIF font in the Montserrat style — medium/semibold, well-kerned — placed tastefully in the upper negative space, in a soft charcoal or warm brown tone that fits the palette, reading EXACTLY: "Fizz for your health". The text must be perfectly and correctly spelled, crisp, and legible — never garbled, misspelled, or scrambled. No other text anywhere.

Keep everything photoreal, premium, and uncluttered — no badges, no price, no extra graphics. Output a crisp high-resolution 1:1 square image.`;

async function main(){
  console.log("generating Peach Mango fizz (Nano Banana Pro, 1:1)…");
  const { buffer, mimeType } = await generateNanoBananaProCombine({
    workspaceId: WS, prompt, imageUrls: [dataUri(REF)], aspectRatio: "1:1",
  });
  const ext = mimeType.includes("jpeg") ? "jpg" : "png";
  const out = `/Users/admin/Desktop/Superfood-Tabs-PeachMango-fizz.${ext}`;
  writeFileSync(out, buffer);
  console.log(`✓ saved ${(buffer.length/1024/1024).toFixed(2)}MB → ${out}`);
}
main().then(()=>process.exit(0)).catch((e)=>{console.error("FAILED:", String(e).slice(0,300));process.exit(1);});
