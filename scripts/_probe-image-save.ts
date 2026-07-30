import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const a=createAdminClient();
  const { data:prod }=await a.from("products").select("id").eq("workspace_id",WS).ilike("title","Amazing Coffee").maybeSingle();
  const { data:sk }=await a.from("creative_skeletons").select("advertiser,format,media_type,days_running,image_url,thumb_path,status").eq("workspace_id",WS).eq("product_id",(prod as any)?.id).order("days_running",{ascending:false}).limit(25);
  let noImg=0, hasUrlNoThumb=0, ok=0;
  const byFormat:Record<string,{img:number,noimg:number}>={};
  for(const s of sk||[]){
    const hasUrl=!!(s as any).image_url, hasThumb=!!(s as any).thumb_path;
    const f=(s as any).format||"?"; (byFormat[f]??={img:0,noimg:0});
    if(!hasUrl && !hasThumb){ noImg++; byFormat[f].noimg++; }
    else if(hasUrl && !hasThumb){ hasUrlNoThumb++; byFormat[f].img++; }
    else { ok++; byFormat[f].img++; }
  }
  console.log(`Amazing Coffee statics (top 25 by days): ok(thumb saved)=${ok} · has image_url but NO thumb_path=${hasUrlNoThumb} · NO image at all=${noImg}`);
  console.log("by format {img/noimg}:", JSON.stringify(byFormat));
  console.log("\nsample no-image rows:");
  for(const s of (sk||[]).filter((x:any)=>!x.image_url&&!x.thumb_path).slice(0,4)) console.log(`  ${(s as any).advertiser} [${(s as any).format}] ${(s as any).days_running}d media=${(s as any).media_type}`);
})().then(()=>process.exit(0));
