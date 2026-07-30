import { loadEnv } from "./_bootstrap"; loadEnv();
import { generateNanoBananaProCombine, NANO_BANANA_MODEL } from "../src/lib/gemini";
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const STYLE="Photorealistic editorial portrait PHOTOGRAPH of a real-looking person, tight CLOSE CROP (top of head at top of frame, cropped just below the collarbone, face fills the frame), looking directly at camera, soft editorial lighting, plain neutral background. Stylish, fashion-forward, real personal taste — modern and distinctive, NOT a corporate headshot, no blazer. NEVER a cartoon/illustration/3D render.";
const CAST=[
  {file:"prue-prompt-review.jpg", look:"a decisive woman in her early 30s with a sleek dark ponytail and sharp cheekbones, wearing a modern deep-plum turtleneck, a precise editorial expression"},
  {file:"ticket-improve.jpg", look:"a sharp, curious man in his late 20s with tousled sandy hair and light stubble, wearing a distinctive forest-green overshirt, an inventive problem-solver's expression"},
];
async function main(){
  const db=createAdminClient();
  for(const c of CAST){
    const prompt=`${STYLE} Subject: ${c.look}. Genuinely distinctive.`;
    let out; try{ out=await generateNanoBananaProCombine({workspaceId:WS,imageUrls:[],prompt,aspectRatio:"1:1" as any}); }
    catch(e:any){ out=await generateNanoBananaProCombine({workspaceId:WS,imageUrls:[],prompt,model:NANO_BANANA_MODEL,aspectRatio:"1:1" as any}); }
    const {error}=await db.storage.from("agent-avatars").upload(c.file,out.buffer,{contentType:out.mimeType,upsert:true});
    console.log(error?`ERR ${c.file}: ${error.message}`:`✓ ${c.file}`);
  }
  process.exit(0);
}
main().catch(e=>{console.error(e.message);process.exit(1);});
