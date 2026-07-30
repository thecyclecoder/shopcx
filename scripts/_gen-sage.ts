import { loadEnv } from "./_bootstrap"; loadEnv();
import { generateNanoBananaProCombine, NANO_BANANA_MODEL } from "../src/lib/gemini";
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const STYLE="Photorealistic editorial portrait PHOTOGRAPH of a real-looking person, tight CLOSE CROP (top of head at top of frame, cropped just below the collarbone, face fills the frame), looking directly at camera, soft editorial lighting, plain neutral background. Stylish, fashion-forward, real personal taste — modern and distinctive, NOT a corporate headshot, no blazer, no LinkedIn stiffness. NEVER a cartoon/illustration/3D render.";
async function main(){
  const db=createAdminClient();
  const prompt=`${STYLE} Subject: a thoughtful man in his early 30s with warm brown skin and short textured dark curls, a neatly kept short beard, wearing a distinctive earthy mustard-toned knit, a calm contemplative pattern-finder's expression — the kind of person who sees the recurring shape in a mountain of history. Genuinely distinctive from a typical office headshot.`;
  let out;
  try { out = await generateNanoBananaProCombine({ workspaceId:WS, imageUrls:[], prompt, aspectRatio:"1:1" as any }); }
  catch(e:any){ console.log("Pro failed, flash:", String(e.message).slice(0,40)); out = await generateNanoBananaProCombine({ workspaceId:WS, imageUrls:[], prompt, model:NANO_BANANA_MODEL, aspectRatio:"1:1" as any }); }
  const { error } = await db.storage.from("agent-avatars").upload("sage-playbook-compiler.jpg", out.buffer, { contentType: out.mimeType, upsert: true });
  console.log(error? "UPLOAD ERR "+error.message : "✓ Sage generated + uploaded");
  process.exit(0);
}
main().catch(e=>{console.error("ERR",e.message);process.exit(1);});
