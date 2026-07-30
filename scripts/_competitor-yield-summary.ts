import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { listAdvertisedProductIds } from "../src/lib/advertised-products";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const a=createAdminClient();
  const advIds=await listAdvertisedProductIds(a, WS);
  const { data:prods }=await a.from("products").select("id,title").eq("workspace_id",WS).in("id",advIds);
  console.log("advertised/hero products (is_advertised=true):", (prods||[]).length);
  const { data:comps }=await a.from("competitors").select("id,brand,product_id").eq("workspace_id",WS);
  const { data:sk }=await a.from("creative_skeletons").select("competitor_id").eq("workspace_id",WS);
  const cnt=new Map<string,number>(); for(const s of sk||[]){ const c=(s as any).competitor_id; if(c) cnt.set(c,(cnt.get(c)||0)+1); }
  for(const p of (prods||[]).sort((x:any,y:any)=>x.title.localeCompare(y.title))){
    const cs=(comps||[]).filter((c:any)=>c.product_id===(p as any).id);
    const withAds=cs.filter((c:any)=>(cnt.get(c.id)||0)>0);
    const zero=cs.filter((c:any)=>(cnt.get(c.id)||0)===0);
    const totalAds=cs.reduce((s:number,c:any)=>s+(cnt.get(c.id)||0),0);
    console.log(`\n▸ ${(p as any).title}: ${cs.length} competitors · ${withAds.length} delivering / ${zero.length} at 0 ads · ${totalAds} ads total`);
    if(zero.length) console.log(`    0-ads: ${zero.map((c:any)=>c.brand).join(", ")}`);
  }
})().then(()=>process.exit(0));
