import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const a=createAdminClient();
  const { data:sk }=await a.from("creative_skeletons").select("id,thumb_path,image_url,platform,format,advertiser").eq("workspace_id",WS);
  const rows=sk||[];
  const noThumb=rows.filter((r:any)=>!r.thumb_path);
  const noImgAtAll=rows.filter((r:any)=>!r.thumb_path && !r.image_url);
  console.log(`library: ${rows.length} total · ${rows.length-noThumb.length} have thumb · ${noThumb.length} NO thumb · ${noImgAtAll.length} no image at all`);
  const byPlat:Record<string,number>={}, byFmt:Record<string,number>={};
  for(const r of noThumb){ byPlat[(r as any).platform||"?"]=(byPlat[(r as any).platform||"?"]||0)+1; byFmt[(r as any).format||"?"]=(byFmt[(r as any).format||"?"]||0)+1; }
  console.log("no-thumb by platform:", JSON.stringify(byPlat));
  console.log("no-thumb by format:", JSON.stringify(byFmt));
  // non-meta platforms overall
  const nonMeta=rows.filter((r:any)=>r.platform && !["facebook","instagram"].includes(String(r.platform).toLowerCase()));
  console.log("non-Meta (google/tiktok/etc) ads:", nonMeta.length, "platforms:", JSON.stringify([...new Set(nonMeta.map((r:any)=>r.platform))]));
})().then(()=>process.exit(0));
