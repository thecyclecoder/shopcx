import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { upsertCompetitor } from "../src/lib/competitors";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const REVERT:Record<string,string>={ wellah:"wellah creatine", momentous:"momentous creatine", thesis:"Thesis nootropic", trip:"TRIP drink", create:"create creatine" };
(async()=>{
  const a=createAdminClient();
  const { data:comps }=await a.from("competitors").select("*").eq("workspace_id",WS);
  for(const c of comps||[]){
    const kw=String((c as any).search_keyword||"").toLowerCase().trim();
    if(REVERT[kw]){
      await upsertCompetitor({ workspace_id:WS, product_id:(c as any).product_id, brand:(c as any).brand, domain:(c as any).domain, pdp_urls:(c as any).pdp_urls, category:(c as any).category, spend_signal:(c as any).spend_signal, source:(c as any).source, status:(c as any).status, evidence:(c as any).evidence, runs_ads_for:(c as any).runs_ads_for, search_keyword:REVERT[kw] } as any);
      console.log(`reverted "${(c as any).search_keyword}" → "${REVERT[kw]}" (needs your exact page)`);
    }
  }
})().then(()=>process.exit(0));
