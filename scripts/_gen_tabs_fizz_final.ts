import { loadEnv } from "./_bootstrap";
loadEnv();
import { readFileSync, writeFileSync } from "fs";
import { generateNanoBananaProCombine } from "../src/lib/gemini";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const BASE = "/Users/admin/Desktop/Superfood-Tabs-PeachMango-fizz-v2b-energetic.jpg";
const uri = `data:image/jpeg;base64,${readFileSync(BASE).toString("base64")}`;

const SPEC = `The PROVIDED IMAGE is a static ad we love. Keep it almost entirely as-is with TWO changes.

PRESERVE exactly: the tall glass of peachy-orange Peach Mango sparkling drink, the effervescent tablet FIZZING at the bottom, the peach slice garnish INSIDE the glass, the ice, the soft cream editorial background, the warm daylight and long soft shadow. KEEP the top headline "Fizz for your health" exactly as it is — same geometric sans-serif, same weight, same charcoal color, same position, with the peachy-orange underline swoosh under "Fizz" — perfectly spelled, do not re-letter or move it.

CHANGE 1 — remove the circular "PEACH MANGO" badge: delete that white circle and its text entirely and cleanly restore the smooth cream background where it was, as if it was never there. No badge, no text in that spot.

CHANGE 2 — add fresh ingredients resting on the cream surface BESIDE and in front of the base of the glass (foreground, to the left and right), styled cleanly and editorially with breathing room, NOT crowding the headline at the top:
- fresh PEACH: a ripe peach half and a couple of peach slices
- fresh MANGO: a ripe mango cheek and a few bright yellow-orange mango slices, clearly mango and distinct from the peach
- TURMERIC: a couple of fresh turmeric roots plus a small scattering of ground turmeric powder for a warm golden accent

Everything photoreal and premium, matching the existing warm palette and soft light. Do NOT introduce any new text anywhere. Output a crisp 1:1 square.`;

async function main(){
  console.log("generating final (drop badge + add peach/mango/turmeric)…");
  const { buffer, mimeType } = await generateNanoBananaProCombine({ workspaceId: WS, prompt: SPEC, imageUrls: [uri], aspectRatio: "1:1" });
  const ext = mimeType.includes("jpeg") ? "jpg" : "png";
  const out = `/Users/admin/Desktop/Superfood-Tabs-PeachMango-fizz-final.${ext}`;
  writeFileSync(out, buffer);
  console.log(`✓ saved ${(buffer.length/1024/1024).toFixed(2)}MB → ${out}`);
}
main().then(()=>process.exit(0)).catch((e)=>{console.error("FAILED:", String(e).slice(0,300));process.exit(1);});
