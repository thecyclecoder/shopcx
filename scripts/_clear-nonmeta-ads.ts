import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const a=createAdminClient();
  // non-Meta = the Google/AdMob text ads (no real creative image) — founder: we don't want google + clear no-image
  const { data:before }=await a.from("creative_skeletons").select("id,platform,thumb_path,image_url").eq("workspace_id",WS);
  const del=(before||[]).filter((r:any)=>{
    const p=String(r.platform||"").toLowerCase();
    const nonMeta = p && !["facebook","instagram"].includes(p);
    const noImg = !r.thumb_path && !r.image_url;
    return nonMeta || noImg;
  });
  for(const r of del) await a.from("creative_skeletons").delete().eq("id",(r as any).id);
  const { count:after }=await a.from("creative_skeletons").select("id",{count:"exact",head:true}).eq("workspace_id",WS);
  console.log(`deleted ${del.length} non-Meta / no-image ads · library now ${after} (all Meta with images)`);
})().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1);});
