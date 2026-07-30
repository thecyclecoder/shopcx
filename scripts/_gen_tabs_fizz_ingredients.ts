import { loadEnv } from "./_bootstrap";
loadEnv();
import { readFileSync, writeFileSync } from "fs";
import { generateNanoBananaProCombine } from "../src/lib/gemini";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const uri = (p: string) => `data:image/jpeg;base64,${readFileSync(p).toString("base64")}`;

const SPEC = `The PROVIDED IMAGE is a finished static ad we love. PRESERVE it almost entirely: keep the tall glass of peachy-orange Peach Mango sparkling drink, the effervescent tablet FIZZING at the bottom, the peach slice garnish INSIDE the glass, the ice, the soft cream editorial background, the lighting, the long soft shadow, and — critically — keep the existing HEADLINE TEXT exactly as it is, perfectly spelled and in the same style, position, color and size. Do NOT re-letter, move, or restyle the text, and do NOT introduce any new text.

ONE change only: add fresh ingredient elements resting on the cream surface BESIDE and in front of the base of the glass (foreground, left and right of the glass), styled cleanly and editorially with a little negative space — do NOT crowd or cover the headline area at the top:
- fresh PEACH: a ripe peach half and a couple of peach slices
- fresh MANGO: a ripe mango cheek and a few bright yellow-orange mango slices (clearly mango, distinct from the peach)
- TURMERIC: a couple of fresh turmeric roots plus a small scattering of ground turmeric powder for a warm golden accent

Keep everything photoreal and premium, matching the existing warm palette and soft daylight. Output a crisp 1:1 square.`;

const jobs = [
  { base: "/Users/admin/Desktop/Superfood-Tabs-PeachMango-fizz-v2a-hero.jpg", out: "/Users/admin/Desktop/Superfood-Tabs-PeachMango-fizz-v2a-ingredients.jpg" },
  { base: "/Users/admin/Desktop/Superfood-Tabs-PeachMango-fizz-v2b-energetic.jpg", out: "/Users/admin/Desktop/Superfood-Tabs-PeachMango-fizz-v2b-ingredients.jpg" },
];
async function main(){
  for (const j of jobs) {
    console.log(`generating ${j.out.split("/").pop()}…`);
    const { buffer } = await generateNanoBananaProCombine({ workspaceId: WS, prompt: SPEC, imageUrls: [uri(j.base)], aspectRatio: "1:1" });
    writeFileSync(j.out, buffer);
    console.log(`  ✓ ${(buffer.length/1024/1024).toFixed(2)}MB`);
  }
}
main().then(()=>process.exit(0)).catch((e)=>{console.error("FAILED:", String(e).slice(0,300));process.exit(1);});
