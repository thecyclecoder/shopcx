import { loadEnv } from "./_bootstrap"; loadEnv();
import { generateNanoBananaProCombine, NANO_BANANA_MODEL } from "../src/lib/gemini";
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const STYLE="Photorealistic editorial portrait PHOTOGRAPH of a real-looking person, tight CLOSE CROP (top of head at the top of the frame, cropped just below the collarbone, face fills the frame), looking directly at camera, soft editorial lighting, plain neutral background. Stylish, fashion-forward, real personal taste — modern and distinctive, NOT a corporate headshot, no blazer, no LinkedIn stiffness. NEVER a cartoon/illustration/3D render.";
const CAST=[
  {file:"sol-ticket-handler.jpg", look:"a warm, decisive man in his early 30s with warm brown skin and a sharp modern fade, wearing a distinctive textured knit in a warm rust tone, calm confident grounded expression"},
  {file:"cora-ticket-analyzer.jpg", look:"a discerning woman in her late 20s with a sleek dark bob and one bold gold statement earring, wearing a modern high-neck top in deep emerald, sharp intelligent evaluating expression"},
  {file:"wren-prompt-analyzer.jpg", look:"a precise androgynous person in their late 20s with cropped platinum hair and subtle freckles, wearing a crisp modern collar in soft lilac, thoughtful careful editor's expression"},
];
async function main(){
  const db=createAdminClient();
  for(const c of CAST){
    const prompt=`${STYLE} Subject: ${c.look}. Genuinely distinctive from a typical office headshot.`;
    let out;
    try { out = await generateNanoBananaProCombine({ workspaceId:WS, imageUrls:[], prompt, aspectRatio:"1:1" as any }); }
    catch(e:any){ console.log(`  ${c.file}: Pro failed (${String(e.message).slice(0,40)}) — retry on flash`); out = await generateNanoBananaProCombine({ workspaceId:WS, imageUrls:[], prompt, model:NANO_BANANA_MODEL, aspectRatio:"1:1" as any }); }
    const { error } = await db.storage.from("agent-avatars").upload(c.file, out.buffer, { contentType: out.mimeType, upsert: true });
    if(error){ console.log(`  ${c.file}: UPLOAD ERR ${error.message}`); continue; }
    const { data } = db.storage.from("agent-avatars").getPublicUrl(c.file);
    console.log(`  ✓ ${c.file} → ${data.publicUrl}`);
  }
  process.exit(0);
}
main().catch(e=>{console.error("ERR",e.message);process.exit(1);});
