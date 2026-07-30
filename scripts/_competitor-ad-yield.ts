import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const a=createAdminClient();
  const { data:comps }=await a.from("competitors").select("id,brand,search_keyword,product_id,status,source").eq("workspace_id",WS);
  const { data:prods }=await a.from("products").select("id,title").eq("workspace_id",WS);
  const pname=new Map((prods||[]).map((p:any)=>[p.id,p.title]));
  const { data:sk }=await a.from("creative_skeletons").select("competitor_id,status").eq("workspace_id",WS);
  const cnt=new Map<string,{total:number,video:number}>();
  for(const s of sk||[]){ const c=(s as any).competitor_id; if(!c) continue; const e=cnt.get(c)||{total:0,video:0}; e.total++; if(String((s as any).status).includes("video")) e.video++; cnt.set(c,e); }
  const byProd:Record<string,any[]>={};
  for(const c of comps||[]){ const p=pname.get((c as any).product_id)||"(unscoped)"; (byProd[p]??=[]).push(c); }
  let zero=0;
  for(const [prod,cs] of Object.entries(byProd)){
    console.log(`\n▸ ${prod}`);
    for(const c of cs.sort((x:any,y:any)=>(cnt.get(y.id)?.total||0)-(cnt.get(x.id)?.total||0))){
      const e=cnt.get((c as any).id)||{total:0,video:0};
      const kw=(c as any).search_keyword?` kw="${(c as any).search_keyword}"`:"";
      const flag=e.total===0?"  ⚠️ 0 ADS":""; if(e.total===0)zero++;
      console.log(`   ${String(e.total).padStart(3)} ads (${e.total-e.video}s/${e.video}v)  ${(c as any).brand}${kw} [${(c as any).status}]${flag}`);
    }
  }
  console.log(`\n=== ${zero} of ${(comps||[]).length} seeded competitors deliver 0 ads ===`);
})().then(()=>process.exit(0));
